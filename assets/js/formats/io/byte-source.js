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

import { ReadWitness, witnessHolds } from './read-witness.js';
import { onAbort, abortReason, awaitWithSignal, cancel, throwIfAborted } from '../../utils/abort.js';
import { isHostUrl, routedFetch } from './host-fetch.js';
import { ResponseClock } from './link.js';
import { MAX_QUIET_MS, budgetOf, HostNotAnswering, realmHosts, retryAfterMilliseconds } from './hosts.js';
import { formatDuration, formatCountOf } from '../../utils/format-units.js';
import { createMirrorSet } from './mirrors.js';
import { KeptCopyDamage, checkedRead } from './page-checks.js';
import { publicLink } from '../../data/sources/link-credentials.js';
import { textWithPublicLinks } from '../../data/sources/link-text.js';
import { fnv1a32 } from '../../utils/fnv1a.js';

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
 *   onHeld?: (() => void)|null, onFetch?: (() => void)|null,
 *   onWait?: ((wait: HostWait|null) => void)|null}) => Promise<Uint8Array>} read
 *   `link`: the link the read is measured on, whose answers time a stalled
 *   request; `onBytes`: hears bytes as they arrive (negative: an attempt that
 *   failed, its bytes taken back); `onHeld`: told when some of the bytes
 *   were answered from memory without a request (`range-cache.js`), so the
 *   read measures no link; `onFetch`: told when a source that first asked
 *   memory sends its request, which the link's round trip is timed from;
 *   `onWait`: told when the read waits for a wait its host named (`HostWait`,
 *   `fetchOnce`), and null once it no longer does
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

/**
 * A read that could not be served, with a `code` from `BYTE_SOURCE_FAILURES`.
 *
 * A failure names the file it could not read by its link's public form
 * (`textWithPublicLinks`, `data/sources/link-text.js`): the request
 * went to the read URL, with whatever signature or key it carries, but the
 * message and `details.url` (shown in notifications, logged to the console)
 * never hold it, whichever site raised the error.
 */
export class ByteSourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(textWithPublicLinks(message), details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ByteSourceError';
    this.code = code;
    this.details = typeof details.url === 'string' ? { ...details, url: publicLink(details.url) } : details;
    /** The host's HTTP status, when it answered one. */
    if (details.status !== undefined) this.status = details.status;
  }
}

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * A file on a web host, until its link is measured: every request may cost a
 * round trip, so neighboring metadata is fetched together and large reads
 * are split to run in parallel. Six requests in flight is what a browser
 * keeps open per HTTP/1.1 host; over HTTP/2 or HTTP/3 a host answers as many
 * at once as its `SETTINGS_MAX_CONCURRENT_STREAMS`, which RFC 9113 (6.5.2)
 * asks to be no smaller than 100 and GitHub sets to 100: reads start there
 * until the protocol is known (`link.js`).
 *
 * Metadata blocks are 16 KiB: an `.h5ad` written by anndata keeps each
 * element's object header, B-tree node and heap together within a few KiB,
 * spread over the whole file (one cluster per element, beside its data), so
 * a larger block fetches mostly data, and a smaller one is no quicker with
 * more requests (measured: 22_decisions_link_model_and_request_planning.md).
 * A read's shape, not a limit.
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
 * read. Asked for whole whatever the link: 512 KiB transfer in less than the
 * round trip another read would cost on every link measured (measured:
 * 22_decisions_link_model_and_request_planning.md). A read's shape, not a
 * limit: a larger head is read on.
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
      if (signal?.aborted) throw abortReason(signal);
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
      if (signal?.aborted) throw abortReason(signal);
      return bytes.subarray(offset, offset + length);
    },
  };
  return Object.freeze(source);
}

/** Waits `milliseconds` on the timers `after` (`ResponseClock`); `signal` ends the wait. */
function sleep(milliseconds, signal, after) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const cancel = after(milliseconds, () => {
      stopWaiting();
      resolve();
    });
    const stopWaiting = onAbort(signal, () => {
      cancel();
      reject(abortReason(signal));
    });
  });
}

/** How often a read waiting for this computer to be online again looks (`navigator.onLine`). */
const ONLINE_POLL_MS = 500;

/**
 * Waits until this computer says it is online again (`online()`), looked at
 * every `ONLINE_POLL_MS` on the timers `after`: a dedicated worker is not
 * reliably told by an `online` event (Chromium), so it looks. `signal` ends
 * the wait.
 */
async function untilOnline(online, signal, after) {
  while (!online()) await sleep(ONLINE_POLL_MS, signal, after);
}

/**
 * How a transient failure is asked again: as TCP retransmits, the waits are
 * the link's own measure, not a schedule. The first wait is the link's
 * retransmission timeout (`ResponseClock.timeoutMs`: from the answers its
 * requests measured, RFC 6298, never under one second), each next one twice
 * the last (RFC 6298 5.5), each stretched by up to a half (`retryWaitMs`).
 * The failure is reported once the request was asked again at least
 * `RETRY_AT_LEAST` times and its waits (and the silences of its stalled
 * attempts) add up to `RETRY_FOR_MS`: RFC 1122 (4.2.3.5) gives a connection
 * up only after at least three retransmissions (R1) and at least 100
 * seconds (R2). A failure that shows it will stay is reported sooner
 * (`worthAskingAgain`). A wait the host names (`Retry-After`, the reset of
 * its request budget, `hosts.js`) is none of these: it is waited for exactly,
 * and never counted.
 */
export const RETRY_AT_LEAST = 3;
export const RETRY_FOR_MS = 100_000;

/**
 * The wait before the `n`-th repeat (from 0) of a request whose link waits
 * `timeoutMs` before it takes a request for lost: `timeoutMs * 2^n`,
 * stretched by up to a half at random (`random` in [0, 1)), so the many
 * requests a busy host turned away at once (S3's `503 SlowDown` to every
 * connection) do not all come back at the same moment and be turned away
 * again.
 *
 * @param {number} n
 * @param {number} timeoutMs
 * @param {() => number} [random]
 * @returns {number}
 */
export function retryWaitMs(n, timeoutMs, random = Math.random) {
  return timeoutMs * 2 ** n * (1 + random() / 2);
}

/**
 * A stretch for `retryWaitMs` drawn from what a request asks for (its URL
 * and range), not from chance: requests of different ranges come back at
 * different moments, and the same request always waits the same (a read
 * made twice fails, or succeeds, after the same time).
 *
 * @param {string} what - The request, as text
 * @returns {() => number} Successive values in [0, 1)
 */
export function spreadOf(what) {
  // FNV-1a over the text, then a 32-bit avalanche per draw.
  const hash = fnv1a32(what);
  let draw = 0;
  return () => {
    let x = (hash + Math.imul(++draw, 0x9e3779b9)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
  };
}

/**
 * A request that got no answer a page may read (`sent` false: not sent, as
 * its host gave none to the requests before it, `hosts.js`
 * `HostNotAnswering`). From a host that answered this site before, CORS is
 * not why (`hosts.js` `answeredBefore`): it refuses this network for now (an
 * "unusual traffic" page without CORS headers), or it fails.
 */
function unansweredFailure(url, label, hosts, cause, { sent = true } = {}) {
  const answeredBefore = hosts.answeredBefore?.(url) === true;
  const host = hostOf(url) ?? 'the host';
  const what = sent ? 'no answer this page may read' : `not asked: ${host} gave no answer this page may read to the requests before it`;
  return new ByteSourceError(
    BYTE_SOURCE_FAILURES.NETWORK,
    answeredBefore
      ? `${label}: ${host} stopped answering this site, which it answered before (${what}): it may be refusing ` +
        'requests from this network for now (hosts do so for a while after many requests from one network), or ' +
        'failing, or this computer lost its connection. Try again later.'
      : `${label}: ${what} (no connection, or an answer without CORS headers, as a host that does not let other ` +
        'websites read it sends, or one busy, failing or refusing requests from this network for now).',
    { cause, url: label, host: hostOf(url), phase: 'answer', answeredBefore, sent }
  );
}

/**
 * Whether an HTTP status says the host failed on its own side, or turns this
 * network away for now: any 5xx, 408 (it timed the request out) or 429 (too
 * many requests). The link is not why, and asking again later may succeed.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isHostSideStatus(status) {
  return Number.isInteger(status) && (status >= 500 || status === 408 || status === 429);
}

/** What a status means, in words. */
const STATUS_WORDS = new Map([
  [401, 'not signed in'],
  [403, 'forbidden'],
  [404, 'not found'],
  [408, 'it timed the request out'],
  [410, 'gone'],
  [429, 'too many requests'],
  [500, 'a server error'],
  [502, 'a gateway error'],
  [503, 'service unavailable'],
  [504, 'a gateway timeout'],
]);

/**
 * Who is at fault when a host does not give what was asked for, as a person
 * acts on it (`hostFaultSentence`):
 *
 * - `failing`: the host fails on its own side (any 5xx, 408);
 * - `limiting`: it limits how fast this network reads it (429, a rate limit
 *   answered otherwise), and says when to ask again when it does;
 * - `refusing`: it refuses this network for now although what was asked
 *   for is public (a 401/403 from a host whose files are all public, or
 *   from one that answered this site before): an outage or a block;
 * - `refused`: the link's permissions (401/403): private, deleted, expired;
 * - `missing`: nothing at that address (404, 410);
 * - `offline`: this computer has no connection;
 * - `connection`: the browser says it is online, but hosts of unrelated
 *   sites all stopped answering at once (`hosts.js` `connectionDown`): this
 *   computer's connection, or a network in between, most likely.
 */
export const HOST_FAULTS = Object.freeze(['failing', 'limiting', 'refusing', 'silent', 'refused', 'missing', 'offline', 'connection']);

/** The fault a status stands for, or null when it names none: any 5xx and 408 failing, 429 limiting. */
export function hostFaultOfStatus(status) {
  if (status === 429) return 'limiting';
  return isHostSideStatus(status) ? 'failing' : null;
}

/**
 * What a progress line says while a request that failed is asked again
 * (`withRetries`): the host, what it answered, and when it is asked again.
 * The one sentence every retrying transport reports through its `onWait`
 * (a reader's activity line, an opening, a community annotation Pull), so a
 * long wait that is really retrying never reads as plain progress.
 *
 * @param {{host: string|null, status?: number|null, service?: string|null,
 *   stalled?: boolean, waitMs?: number|null, attempt: number}} retry -
 *   `attempt`: the attempt about to be made (2 for the first repeat)
 * @returns {string}
 */
export function hostRetrySentence({ host, status = null, service = null, stalled = false, waitMs = null, attempt }) {
  const named = host ?? 'The host';
  const where = service === null ? named : host === null ? service : `${service} (${host})`;
  const words = STATUS_WORDS.get(status) ?? (status >= 500 ? 'a server error' : null);
  const what = stalled
    ? 'stopped sending'
    : Number.isInteger(status)
    ? `is answering with errors (HTTP ${status}${words === null ? '' : `, ${words}`})`
    : 'did not answer';
  const when = waitMs !== null && waitMs >= 1000 ? ` in ${formatDuration(waitMs)}` : '';
  return `${where} ${what}; trying again${when} (attempt ${attempt})…`;
}

/**
 * The one sentence a host fault (`HOST_FAULTS`) is said to a person with,
 * whichever layer met it and wherever it is shown (an opening, a gene, an
 * analysis, a catalog): who is at fault, the status, and what to do.
 * `service` is the provider the host serves ("NCBI GEO", "Zenodo"), or null
 * for a host met by its address alone; `what` what was asked for (a file
 * name, "record 1"); `retryAfterMs` the wait a limiting host named, or null.
 *
 * @param {{kind: string, host: string, status?: number|null, what: string,
 *   service?: string|null, retryAfterMs?: number|null}} fault
 * @returns {string}
 */
export function hostFaultSentence({ kind, host, status = null, what, service = null, retryAfterMs = null }) {
  const owner = service ?? host;
  const where = service === null ? host : `${service} (${host})`;
  const words = STATUS_WORDS.get(status) ?? (status >= 500 ? 'a server error' : null);
  const answer = status === null ? '' : ` (HTTP ${status}${words === null ? '' : `, ${words}`})`;
  const seconds = retryAfterMs !== null && retryAfterMs >= 1000 ? Math.ceil(retryAfterMs / 1000) : null;
  const wait = seconds === null ? null : seconds < 60 ? `${seconds} s` : formatDuration(seconds * 1000);
  switch (kind) {
    case 'failing':
      return `${where} is not answering${answer} for ${what}: a problem on ${owner}'s side, not with the link ` +
        'or with Cellucid. It usually passes; try again later.';
    case 'limiting':
      return `${where} is limiting requests from this network${answer} for ${what}: ${owner}'s own limit, not a ` +
        `problem with the link or with Cellucid. ${wait === null ? 'Try again in a few minutes.' : `Try again in ${wait}, as ${owner} asks.`}`;
    case 'refusing':
      return `${where} is refusing requests from this network for now${answer} for ${what}, which it gives ` +
        `everyone: a problem on ${owner}'s side (an outage, or a block after many requests from one network), not ` +
        'with the link or with Cellucid. Try again later.';
    case 'silent':
      return `${where} stopped answering this site, which it answered before (${what}): it may be refusing ` +
        'requests from this network for now (hosts do so for a while after many requests from one network), or ' +
        'failing, or this computer lost its connection. Try again later.';
    case 'refused':
      return `${where} refused ${what}${answer}: it is private or deleted, or the link has expired. This is the ` +
        `link's permissions, not a fault of ${owner} or Cellucid. Ask its owner for a public link.`;
    case 'missing':
      return `${what} was not found at ${where}${answer}: the link or record does not exist, or it moved. Check ` +
        'the link, or ask its owner.';
    case 'offline':
      return `This computer is offline, so ${what} cannot be read from ${where}: the connection on this side, not ` +
        `${owner} or Cellucid. Connect, then try again.`;
    case 'connection':
      return `${where} gave no answer for ${what}, and neither did the other hosts asked in the last minute: most ` +
        `likely this computer's connection (or a network in between), not ${owner} or Cellucid. Check the connection, ` +
        'then try again.';
    default:
      throw new TypeError(`Unknown host fault "${kind}".`);
  }
}

/**
 * The host fault (`HOST_FAULTS`) a request no answer arrived for stands for
 * (`unansweredFailure`), or null where nobody can tell: this computer offline
 * (`offline`); every host asked lately silent at once (`connection`,
 * `hosts.connectionDown`); a host that answered this site before now silent
 * (`silent`: it refuses this network for now, fails, or the connection
 * dropped; its own sentence says all three). A host never
 * answered may be a typo or a site that does not let others read it: said as
 * it was.
 *
 * @param {ByteSourceError} error
 * @param {{connectionDown: (url: string) => boolean}} hosts
 * @returns {{kind: string, host: string, status: null, what: string, service: null, retryAfterMs: null}|null}
 */
export function unansweredFault(error, hosts) {
  if (error?.code !== BYTE_SOURCE_FAILURES.NETWORK) return null;
  const host = error.details?.host ?? null;
  if (typeof host !== 'string' || host === '') return null;
  const url = typeof error.details?.url === 'string' && URL.canParse(error.details.url) ? error.details.url : `https://${host}/`;
  const what = askedFor(error.details?.asked ?? url);
  const fault = kind => ({ kind, host, status: null, what, service: null, retryAfterMs: null });
  if (!hosts.online()) return fault('offline');
  if (hosts.connectionDown(url)) return fault('connection');
  if (error.details?.answeredBefore === true) return fault('silent');
  return null;
}

/**
 * What a request named by a URL asked for, for a person: the path from the
 * last file or store it names (`GSE1_x.h5ad`, `atlas.zarr/X/data/0.0`),
 * else its last part, else its host; any other label as it is.
 */
function askedFor(what) {
  if (!URL.canParse(what)) return what;
  const url = new URL(what);
  const parts = url.pathname.split('/').filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const named = parts.findLastIndex(part => /^[^.].*\.[A-Za-z0-9]+$/.test(part));
  if (named !== -1) return parts.slice(named).join('/');
  return parts.at(-1) ?? url.host;
}

/** Whether an HTTP status says the host may answer if asked again. */
export function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501 && status !== 505);
}

/**
 * The reasons a Google API's JSON error names a rate limit with (Drive
 * answers its rate limits with 403, not 429): the classic error's
 * `errors[].reason` and the newer one's `details[].reason`.
 */
const RATE_LIMITING_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

/** The reason a JSON error body names (`{error: {errors: [{reason}]}}` or `{error: {details: [{reason}]}}`), or null. */
/**
 * A `409` answer to a read (`said`: its plain-text body, when it sent one):
 * the file the bytes come from changed where they are served while it was
 * open, as Cellucid's servers answer (`cellucid serve` and R's
 * `cellucid_serve()`: a file written again or replaced on disk, its server's
 * own sentence saying what to do). Refused as a change (`CHANGED`), never
 * asked again; the server's sentence is said as it is.
 *
 * @param {string} name - The file or store, as it is said
 * @param {string|null} said
 * @param {Object} [details]
 * @returns {ByteSourceError}
 */
export function changedWhereServed(name, said, details = {}) {
  const own = typeof said === 'string' && said.length > 0 && said.length <= 400 && !/[<>{}]/.test(said) ? said.trim() : null;
  return new ByteSourceError(
    BYTE_SOURCE_FAILURES.CHANGED,
    own ?? `${name} changed where it is served while it was open (HTTP 409): serve it again, or open it again, to read it as it is now.`,
    { status: 409, ...details }
  );
}

export function errorReasonOf(said) {
  if (typeof said !== 'string') return null;
  let body;
  try {
    body = JSON.parse(said);
  } catch {
    return null;
  }
  const error = body?.error;
  const reason = error?.errors?.[0]?.reason ?? error?.details?.find?.(detail => typeof detail?.reason === 'string')?.reason ?? null;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Whether an answer says the host limits how fast it is read: HTTP 429, or a
 * 403 that says so -- its JSON error names a rate limit
 * (`RATE_LIMITING_REASONS`: Google's APIs), its request budget is spent
 * (`X-RateLimit-Remaining: 0`: GitHub's API answers its limit so), or it
 * names when to ask again (`Retry-After`: GitHub's secondary rate limits
 * answer 403 with a `Retry-After` while the budget has requests left,
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit;
 * a refusal that will pass is no refusal of access). `said`: the answer's
 * body, when it was read (`fetchOnce`).
 *
 * @param {Response} response
 * @param {string|null} [said]
 * @returns {boolean}
 */
export function isLimitAnswer(response, said = null) {
  const status = response.status;
  if (status === 429) return true;
  if (status !== 403) return false;
  return RATE_LIMITING_REASONS.has(errorReasonOf(said)) ||
    budgetOf(response.headers)?.remaining === 0 ||
    retryAfterMilliseconds(response.headers.get('Retry-After')) !== null;
}

/** Whether an answer says the host may answer if asked again: a transient status, or a rate limit (`isLimitAnswer`). */
export function isTransientAnswer(response, said = null) {
  return isTransientStatus(response.status) || isLimitAnswer(response, said);
}

/** The host's own words in an answer's body: the first line of a `text/plain` one, or null. */
function wordsOf(response, said) {
  if (typeof said !== 'string' || !/^text\/plain\b/i.test(response.headers.get('Content-Type') ?? '')) return null;
  const line = said.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/** The host of a URL, or null. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The error of a transient answer (`isTransientAnswer`), naming what was
 * asked. `said`: its body, when read (`fetchOnce`): a rate limit's reason,
 * or the host's words (`text/plain`: a served store says how far it is in
 * laying a matrix out). Its `namedWaitMs` is the wait the host named, or
 * null: a `Retry-After` the page may read of a second or more (its
 * resolution: `0` asks again now, as if nothing were named), or, for a rate
 * limit, the reset of a budget with nothing left (`hosts.js`). Such a wait is
 * waited for exactly and not counted as a failure (`withRetries`).
 *
 * @param {Response} response
 * @param {string} what - How the failure names the request
 * @param {string|null} [said]
 * @returns {ByteSourceError}
 */
export function transientStatusError(response, what, said = null) {
  const status = response.status;
  const limiting = isLimitAnswer(response, said);
  const retryAfter = response.headers.get('Retry-After');
  const askedMs = retryAfterMilliseconds(retryAfter);
  // How long the host's budget holds it after this refusal, as the book of
  // hosts reckons it (`fetchOnce`): a second or more, the headers'
  // resolution, names the wait. A reset already past by this machine's
  // clock (the host's runs behind) names none, and the request is asked
  // again as any busy one is, never at once and again.
  const held = limiting ? heldByHost.get(response) ?? null : null;
  const namedWaitMs = askedMs !== null && askedMs >= 1000
    ? askedMs
    : held !== null && held >= 1000 ? held : null;
  const words = wordsOf(response, said);
  const reason = status === 403 ? errorReasonOf(said) : null;
  return new ByteSourceError(
    limiting ? BYTE_SOURCE_FAILURES.RATE_LIMITED : BYTE_SOURCE_FAILURES.UNAVAILABLE,
    limiting
      ? `${what}: the host is limiting how fast it is read (HTTP ${status}${reason === null ? '' : `, ${reason}`}).`
      : `${what}: the host could not answer (HTTP ${status})${words === null ? '' : `: ${words}`}.`,
    {
      status,
      retryAfter,
      limiting,
      namedWaitMs,
      // Who named the wait, and what it said: the wait's notice (`withRetries`).
      host: hostOf(what),
      // What was asked for, as a person reads it: a failure's sentence (`withRetries`).
      asked: askedFor(what),
      words,
      // What a repeat of the same failure looks like (`withRetries`).
      signature: `${status}:${response.headers.get('Content-Length') ?? ''}`,
    }
  );
}

/**
 * The error of an answer that is neither the bytes asked for nor transient
 * (a 404, a 416), naming what was asked. `said`: its body, when read: an
 * API's error reason, and the host's words (`text/plain`: a served store
 * says what it could not find), kept as `details.words`.
 *
 * @param {Response} response
 * @param {string} what - How the failure names the request
 * @param {string|null} [said]
 * @returns {ByteSourceError}
 */
export function refusedStatusError(response, what, said = null) {
  const status = response.status;
  const reason = errorReasonOf(said);
  const words = wordsOf(response, said);
  return new ByteSourceError(
    BYTE_SOURCE_FAILURES.HTTP,
    `${what}: the host answered HTTP ${status}${reason === null ? '' : ` (${reason})`}.`,
    { status, ...(reason === null ? {} : { reason }), ...(words === null ? {} : { words }) }
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
  // Also one rebuilt on this side of a worker (`utils/error-wire.js`: its
  // name, code and details kept, its class not).
  return (error instanceof ByteSourceError || error?.name === 'ByteSourceError') &&
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
 * The body of an answer the caller does not read (an error), when it says
 * something a page can use: a `text/plain` or JSON body (a host's words, an
 * API's error reason) of the length the host states. Any other is canceled
 * unread.
 */
async function saidOf(response) {
  const type = response.headers.get('Content-Type') ?? '';
  const length = Number(response.headers.get('Content-Length'));
  if (response.status < 400 || !/^(text\/plain|application\/(problem\+)?json)\b/i.test(type) || !Number.isSafeInteger(length)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * How long its host's budget holds the host after a refusal for its limit,
 * by the answer (`fetchOnce` records it from the book of hosts the request
 * was counted in; `transientStatusError` reads it).
 *
 * @type {WeakMap<Response, number>}
 */
const heldByHost = new WeakMap();

/**
 * What a request that waits for its host is told (`onWait`): the host, how
 * long (null: until the host answers more), and a sentence for the person.
 *
 * @typedef {{host: string|null, untilMs: number|null, text: string}} HostWait
 */

/** A wait for a host's request budget (`hosts.js` `admit`), as a `HostWait`. */
function budgetWait({ host, untilMs, limit }) {
  const pace = limit === null ? '' : ` (${formatCountOf(limit, 'request')} a window)`;
  return {
    host,
    untilMs,
    text: `${host} limits how many requests it answers${pace}: ` +
      (untilMs === null ? 'the next go once it answers those on their way.' : `the next go in ${formatDuration(untilMs)}.`),
  };
}

/**
 * One request to a web host, never left hanging: `{response, bytes, said}`,
 * the body read when `wantsBody(response)` says so (else `bytes` null, and
 * `said` the body of an error answer that says something, `saidOf`). The
 * request is aborted as stalled once neither it, nor its link, nor any
 * request to its host (`hosts.js`: the browser's connections to a host are
 * shared by every reader of it) has received anything for the link's
 * timeout (`ResponseClock`): a host that never answers, or stops sending a
 * body, fails the request with `STALLED` instead of holding it forever. A
 * connection that fails (a network error, a host's answer without CORS
 * headers, a body cut short) is `NETWORK`. Both name the URL. `signal`
 * cancels.
 *
 * It is sent once its host's request budget allows (`hosts.js` `admit`): a
 * host that says how many requests it answers per window is never asked
 * past it, and one that refused a request for its limit is asked less at
 * once. Its answer tells the budget what the host said. The wait is the
 * host's, not a silence: the stall watch starts once the request is sent,
 * and `onWait` hears it (`HostWait`, then null when it ends). A file's range
 * read or a store folder's object read (`burst`) whose address lost two
 * rounds in a row is not sent for a while
 * (`hosts.js`), and fails at once, unsent (`sent: false`). Such a failure
 * says whether the host answered this site before (`answeredBefore`): then
 * it is not CORS but a host refusing this network for now, or failing.
 *
 * @param {string} url
 * @param {RequestInit} init - Sent as given, with the request's own signal
 * @param {{fetchImpl: typeof fetch, signal?: AbortSignal|null, clock?: ResponseClock,
 *   wantsBody?: (response: Response) => boolean, expectedBytes?: number,
 *   onBytes?: ((bytes: number) => void)|null, label?: string,
 *   hosts?: ReturnType<import('./hosts.js').createHostBook>,
 *   onWait?: ((wait: HostWait|null) => void)|null}} options
 *   `onBytes` hears each piece of the body as it arrives
 *   `expectedBytes`: the length of a range asked for, which a host that
 *   buffers it may take to transfer before answering (`patienceMs`)
 *   `label`: how failures name the request (the URL by default); a
 *   pre-authenticated URL is named by its display link instead
 *   `hosts`: the book of hosts the request is counted in (this realm's)
 *   `stream`: a body wanted is not gathered in memory but handed over as it
 *   arrives (`pieces`, an async iterator of its pieces: a whole download
 *   written to storage as it comes), still watched for silence until it
 *   ends or the iterator is left; `waits` false: a request whose answer is
 *   optional is not held for its host's budget, and fails at once as
 *   `RATE_LIMITED` when the host may not be asked now; `burst`: one of a
 *   file's many range reads (`true`), or of a store folder's many object
 *   reads (the folder's root URL), counted by that address (`hosts.js`
 *   `admit`)
 * @returns {Promise<{response: Response, bytes: Uint8Array|null, said: string|null,
 *   pieces?: AsyncGenerator<Uint8Array, void, void>}>}
 */
export async function fetchOnce(url, init, { fetchImpl, signal = null, clock = new ResponseClock(), wantsBody = response => response.ok, expectedBytes = 0, onBytes = null, label = url, hosts = realmHosts, onWait = null, stream = false, waits = true, burst = false }) {
  if (signal?.aborted) throw abortReason(signal);
  let answeredHost = hosts.admit(url, {
    signal,
    waits,
    burst,
    onWait: onWait === null ? null : wait => onWait(wait === null ? null : budgetWait(wait)),
  });
  if (answeredHost === null) {
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.RATE_LIMITED,
      `${label}: the host's request budget is spent for now; not waited for.`,
      { url: label, limiting: true }
    );
  }
  // Admitted at once, the request goes out in this task; else once the budget allows.
  if (typeof answeredHost !== 'function') {
    try {
      answeredHost = await answeredHost;
    } catch (cause) {
      // Its host gave nothing to the last two requests: not sent (`hosts.js`).
      if (cause instanceof HostNotAnswering) throw unansweredFailure(url, label, hosts, cause, { sent: false });
      throw cause;
    }
  }
  let hostTold = false;
  const tellHost = (response, verdict) => {
    if (hostTold) return;
    hostTold = true;
    answeredHost(response, verdict);
  };
  const controller = new AbortController();
  const stopCaller = onAbort(signal, () => controller.abort(abortReason(signal)));
  const started = clock.now();
  let lastAt = started;
  // When this request last saw its host deliver to another request.
  let hostDeliveries = hosts.deliveries(url);
  let hostAt = -Infinity;
  let silentMs = null;
  let cancelWatch = null;
  // A notebook's kernel answers its requests one after another, and none
  // while a cell runs: a request to it is never asked again (that would
  // only queue a copy behind it), and its silence is said, not ended.
  const serial = isHostUrl(url);
  const watch = () => {
    const deliveries = hosts.deliveries(url);
    if (deliveries !== hostDeliveries) {
      hostDeliveries = deliveries;
      hostAt = clock.now();
    }
    const quietSince = Math.max(lastAt, clock.lastActivityAt, hostAt);
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
  /** The failure a request that threw `cause` is, named as the read knows it. */
  const failureOf = cause => {
    if (silentMs !== null) {
      return new ByteSourceError(
        BYTE_SOURCE_FAILURES.STALLED,
        `${label}: ${phase === 'answer' ? 'no answer' : 'no more bytes'} for ${formatDuration(silentMs)}.`,
        { cause, url: label, phase, silentMs }
      );
    }
    if (cause instanceof ByteSourceError) return cause;
    if (phase !== 'answer') {
      return new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, `${label}: the connection dropped while reading.`, { cause, url: label, phase });
    }
    return unansweredFailure(url, label, hosts, cause);
  };
  const finish = () => {
    cancelWatch?.();
    stopCaller();
  };
  // A streamed body is finished by its iterator, not here.
  let streaming = false;
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    lastAt = clock.now();
    clock.answered(lastAt - started);
    hosts.rememberAnswer(url, lastAt - started);
    hosts.delivered(url);
    if (!wantsBody(response)) {
      const said = await saidOf(response);
      // A refusal for the host's limit: the host asked less, for as long as it named.
      const limiting = isLimitAnswer(response, said);
      tellHost(response, { limiting, waitMs: limiting ? retryAfterMilliseconds(response.headers.get('Retry-After')) : null });
      if (limiting) heldByHost.set(response, hosts.heldForMs(url));
      return { response, bytes: null, said };
    }
    tellHost(response);
    phase = 'body';
    if (stream && response.body !== null && typeof response.body?.getReader === 'function') {
      streaming = true;
      const reader = response.body.getReader();
      const pieces = (async function* bodyPieces() {
        let ended = false;
        try {
          for (;;) {
            let piece;
            try {
              piece = await reader.read();
            } catch (cause) {
              if (signal?.aborted) throw abortReason(signal);
              throw failureOf(cause);
            }
            if (piece.done) {
              ended = true;
              return;
            }
            lastAt = clock.now();
            clock.received();
            hosts.delivered(url);
            onBytes?.(piece.value.length);
            yield piece.value;
          }
        } finally {
          // Left early (a cancel, a refused write): the answer is let go.
          if (!ended) await reader.cancel().catch(() => {});
          finish();
        }
      })();
      return { response, bytes: null, said: null, pieces };
    }
    const bytes = await readBody(response, length => {
      lastAt = clock.now();
      clock.received();
      hosts.delivered(url);
      onBytes?.(length);
    });
    return { response, bytes, said: null };
  } catch (cause) {
    // A request with no answer a page may read is lost (`hosts.js`); one
    // canceled or ended as stalled is not.
    tellHost(null, { lost: phase === 'answer' && silentMs === null && !signal?.aborted && !(cause instanceof ByteSourceError) });
    if (signal?.aborted) throw abortReason(signal);
    throw failureOf(cause);
  } finally {
    if (!streaming) finish();
  }
}

/**
 * Whether a transient failure is worth asking again, given the failures of
 * the same request before it. The signs that a host will answer later are
 * asked again for as long as `withRetries` asks anything: a `Retry-After`
 * (the host names when), a status that says the host is busy or its
 * gateway is (408, 429, 502, 503, 504, or a rate limit answered otherwise:
 * Google's 403, `isLimitAnswer`; S3's `503 SlowDown` carries no
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
 *   Pages sends without CORS headers is answered on the next request;
 * - a request not sent, its host left unasked after two rounds of requests
 *   got no answer (`hosts.js` `HostNotAnswering`).
 *
 * @param {ByteSourceError} error
 * @param {ByteSourceError[]} before - The same request's earlier failures
 * @returns {boolean}
 */
/** Statuses that say the host, or a gateway before it, is busy: asked again for as long as anything is. */
const BUSY_STATUSES = new Set([408, 429, 502, 503, 504]);

export function worthAskingAgain(error, before) {
  const { code, details = {} } = error;
  if (code === BYTE_SOURCE_FAILURES.STALLED) return true;
  if (code === BYTE_SOURCE_FAILURES.NETWORK) {
    // Not sent: its host is left unasked for now (`hosts.js` `HostNotAnswering`).
    if (details.sent === false) return false;
    if (details.phase === 'body') return true;
    return !before.some(earlier => earlier.code === BYTE_SOURCE_FAILURES.NETWORK && earlier.details?.phase !== 'body');
  }
  if (code === BYTE_SOURCE_FAILURES.RATE_LIMITED || code === BYTE_SOURCE_FAILURES.UNAVAILABLE) {
    if (retryAfterMilliseconds(details.retryAfter) !== null || BUSY_STATUSES.has(details.status) || details.limiting === true) return true;
    return !before.some(earlier => earlier.details?.signature !== undefined && earlier.details.signature === details.signature);
  }
  return true;
}

/**
 * Whether a failure is a host that answered this site before now sending
 * nothing a page may read (no connection, or an answer without CORS
 * headers: S3's and Zenodo's refusals of a network that sent them much),
 * or a request held unsent while it does (`hosts.js` `HostNotAnswering`).
 */
export function refusesForNow(error) {
  return error?.code === BYTE_SOURCE_FAILURES.NETWORK && error.details?.answeredBefore === true && error.details?.phase === 'answer';
}

/**
 * `attempt(n)` until it succeeds, repeating it after a transient failure
 * (`isTransientFailure`, or as `retryable` decides) that is worth asking
 * again (`worthAskingAgain`), with waits that grow from the link's
 * retransmission timeout (`retryWaitMs`), never shorter than a `Retry-After`
 * asks; a stalled request is repeated at once (its silence was the wait).
 * The last failure is thrown once the request was asked again at least
 * `RETRY_AT_LEAST` times over at least `RETRY_FOR_MS`, or the failure is
 * known to stay, saying how many times the request was made.
 *
 * That patience is for a read its host already delivered to (`delivered`:
 * the caller knows the same address answered these very requests before, a
 * file whose ranges or a store whose objects arrived). A host that has
 * delivered nothing to this read yet and answers that it is busy or failing
 * (HTTP 408, 429, 5xx, a rate limit; `isTransientAnswer`) is reported once
 * asked again `RETRY_AT_LEAST` times (RFC 1122's R1 alone, a few seconds):
 * a catalog, a provider's API, a file's or a store's opening is what a
 * person waits on with nothing on screen, and a server answering with
 * errors is said to them (with their "Try again"), not waited on. A request
 * that gets no answer at all (a stall, a failed connection) keeps the whole
 * patience either way: slowness is never made a failure by a count.
 *
 * A host that answered this site before and now sends nothing a page may
 * read (`refusesForNow`), on a read it delivered to (`delivered`, so neither
 * CORS nor a host that cannot serve ranges is why), is waited for, never
 * failed: asked again after a back-off from the link's retransmission
 * timeout, doubled up to RFC 6298's 60 s, uncounted, `onWait` told in plain
 * words, for as long as the read is wanted (its `signal` ends it).
 *
 * A wait the host names (`transientStatusError`'s `namedWaitMs`: a
 * `Retry-After` of a second or more, a request budget's reset) is not a
 * failure: it is waited for exactly, however often, and counts toward
 * neither. A limit's wait holds the whole host (`hosts.js`), so the next
 * attempt waits for its admission; any other (a `503` of a server
 * preparing what was asked for) holds this request only, and `onWait`
 * hears it (`HostWait`: the host's own words when it sent some, then null
 * once the request is asked again).
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} attempt
 * @param {{signal?: AbortSignal|null, retryable?: (error: unknown) => boolean,
 *   onRetry?: ((error: ByteSourceError, attempts: number) => void)|null,
 *   onWait?: ((wait: HostWait|null) => void)|null,
 *   clock?: ResponseClock, random?: () => number}} [options]
 *   `delivered(error)`: whether the host already delivered to this read: its
 *   busy answers are asked again for the whole patience and its refusal for
 *   now (`refusesForNow`) is waited out (above);
 *   `onRetry` hears each failure that is asked again, with the attempts made
 *   so far; `clock`, the link whose retransmission timeout the waits grow
 *   from and whose timers they run on (`ResponseClock`; a fresh one, of
 *   real time, by default); `random`, what stretches each wait
 *   (`retryWaitMs`; tests give a fixed one); `online`, whether this computer
 *   says it is online (the book of hosts': `hosts.js` `createHostBook`);
 *   `service`, the provider the host serves ("GitHub"), named in the line
 *   each repeat says through `onWait` (`hostRetrySentence`)
 * @returns {Promise<T>}
 */
export async function withRetries(attempt, { signal = null, retryable = isTransientFailure, onRetry = null, onWait = null, clock = new ResponseClock(), random = Math.random, delivered = () => false, hosts = realmHosts, online = () => hosts.online(), service = null } = {}) {
  const failures = [];
  // Whoever owns the request's progress line hears its waits and repeats:
  // the caller's `onWait`, else the link the request runs on (`clock.onWait`,
  // `anndata/open.js` publishes it to its opening).
  const tell = wait => (onWait ?? clock.onWait ?? null)?.(wait);
  // A repeat said on the progress line (`hostRetrySentence`) until the
  // request it repeats settles.
  let retrySaid = false;
  const settleRetry = () => {
    if (!retrySaid) return;
    retrySaid = false;
    tell(null);
  };
  // Repeats counted against the patience (RFC 1122 R1, R2), and their waits.
  let repeats = 0;
  let waited = 0;
  // Rounds a host that answered before gave nothing a page may read (`refusesForNow`).
  let refusals = 0;
  for (let n = 0; ; n++) {
    try {
      const value = await attempt(n);
      settleRetry();
      return value;
    } catch (error) {
      settleRetry();
      if (signal?.aborted) throw abortReason(signal);
      if (!retryable(error)) throw error;
      const named = error.details?.namedWaitMs ?? null;
      if (named !== null) {
        // The host said when: no failure. A limit's wait is its budget's.
        if (error.details.limiting !== true) {
          const host = error.details.host ?? null;
          tell({
            host,
            untilMs: named,
            text: error.details.words ?? `${host ?? 'The host'} asked to be asked again in ${formatDuration(named)}.`,
          });
          await sleep(named, signal, clock.after);
          tell(null);
        }
        continue;
      }
      if (refusesForNow(error) && delivered(error) && !online()) {
        // This computer is offline: no host refuses anything. The read waits
        // for the connection, not a back-off (which would outlast the outage),
        // and is asked again the moment it is back.
        const host = error.details?.host ?? hostOf(error.details?.url ?? '') ?? null;
        tell({
          host,
          untilMs: null,
          text: 'This computer is offline: reading goes on as soon as it is back; what was read is kept.',
        });
        await untilOnline(online, signal, clock.after);
        tell(null);
        continue;
      }
      if (refusesForNow(error) && delivered(error)) {
        // A host that answered this site and now sends nothing a page may
        // read refuses this network for now (or fails): the read waits for
        // it, asked again after a back-off from the link's retransmission
        // timeout, doubled to RFC 6298's 60 s, while the book of hosts holds
        // its other requests (`hosts.js` `lose`) and paces it once it
        // answers; uncounted, for as long as the read is wanted. What was
        // read is kept: a read in progress (a graph's edges, genes for all
        // cells) goes on where it was instead of failing whole.
        const wait = Math.min(MAX_QUIET_MS, retryWaitMs(refusals++, clock.timeoutMs, random));
        const host = error.details?.host ?? hostOf(error.details?.url ?? '') ?? null;
        tell({
          host,
          untilMs: wait,
          text: `${host ?? 'The host'} stopped answering this site, which it answered before: it may be refusing requests ` +
            `from this network for now (hosts do so for a while after many requests). Asking again in ${formatDuration(wait)}; ` +
            'what was read is kept.',
        });
        await sleep(wait, signal, clock.after);
        tell(null);
        continue;
      }
      const again = worthAskingAgain(error, failures);
      failures.push(error);
      // A busy answer from a host that delivered nothing to this read yet:
      // reported after R1's repeats, not waited on for R2's 100 s (above).
      const answered = error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE;
      const patience = answered && !delivered(error) ? 0 : RETRY_FOR_MS;
      if (!again || (repeats >= RETRY_AT_LEAST && waited >= patience)) {
        const asked = `${error.message} Asked ${n + 1} time${n === 0 ? '' : 's'}.`;
        const host = error.details?.host ?? null;
        const status = error.details?.status;
        if (answered && host !== null && (isHostSideStatus(status) || error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED)) {
          // The host kept answering that it fails on its side: said so, for
          // the person, wherever it is shown (an opening, a gene, an
          // analysis); the requests, under Details (its cause).
          const what = error.details.asked ?? host;
          const kind = error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED ? 'limiting' : hostFaultOfStatus(status);
          const retryAfterMs = retryAfterMilliseconds(error.details?.retryAfter ?? null);
          const fault = { kind, host, status, what, service: null, retryAfterMs };
          throw new ByteSourceError(error.code, hostFaultSentence(fault), {
            ...error.details,
            cause: new ByteSourceError(error.code, asked, { ...error.details, attempts: n + 1 }),
            attempts: n + 1,
            explained: true,
            hostFault: fault,
          });
        }
        // A request no answer arrived for keeps its own words (they name its
        // address, for Details) and says whose problem it is where that is
        // known (`unansweredFault`), for a sentence without the address.
        const unanswered = unansweredFault(error, hosts);
        throw new ByteSourceError(error.code, asked, {
          ...error.details,
          cause: error.details?.cause ?? error.cause,
          attempts: n + 1,
          ...(unanswered === null ? {} : { hostFault: unanswered }),
        });
      }
      onRetry?.(error, n + 1);
      repeats++;
      const stalled = error.code === BYTE_SOURCE_FAILURES.STALLED;
      // A `Retry-After` under a second asks again no sooner than the link's own wait would.
      const wait = stalled ? null : Math.max(retryAfterMilliseconds(error.details?.retryAfter) ?? 0, retryWaitMs(repeats - 1, clock.timeoutMs, random));
      // Said on whatever progress line owns the request: a wait that is
      // really asking again never reads as plain progress.
      const host = error.details?.host ?? hostOf(error.details?.url ?? '') ?? null;
      tell({
        host,
        untilMs: wait,
        text: hostRetrySentence({ host, status: error.details?.status ?? null, service, stalled, waitMs: wait, attempt: n + 2 }),
      });
      retrySaid = true;
      if (stalled) {
        waited += error.details?.silentMs ?? 0;
        continue;
      }
      waited += wait;
      await sleep(wait, signal, clock.after);
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
 * together went out one round trip after another (Firefox and WebKit do not
 * do this, and with `no-store` neither does Chromium). The size comes from
 * the caller (provider metadata or a probe), because many hosts do not expose
 * `Content-Range` to scripts. After a
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
 * URL only when the request may use its HTTP cache (Chromium only under
 * `cache: 'default'`, Firefox under `'default'` and `'no-cache'`, WebKit under
 * every mode). Chromium's HTTP cache then lets one request of a
 * URL through at a time, so the ranges of one URL would go out one after
 * another. A target that names a lane parameter (`lane`, the name of a query
 * parameter the host ignores) gives each request in flight its own stable
 * URL, `<url>&<lane>=<n>` with `n` the lowest number no request in flight
 * holds, read under `cache: 'default'`: each lane's preflight is asked for
 * once and kept, and no two requests in flight share a URL. Only a host whose
 * answers no cache may reuse (Google Drive's: `private, max-age=0,
 * must-revalidate`, no validators) names a lane, so nothing is ever answered
 * from the cache (measured: 22_decisions_link_model_and_request_planning.md).
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
 * and fails as it would without the check. An access that knows what a rate
 * limit means at its provider (`access.limited`, a sentence: Google Drive's
 * public reads share one API key's quota with every visitor) names it so in
 * the notices of the repeats; one whose target names a version
 * (`access.isChanged(status)`: Google Drive's revision of a signed-in file)
 * fails a read whose version is gone as `CHANGED`.
 *
 * A redirected URL reused (above) on another host than the one asked is
 * asked with `Range` alone: a sign-in's headers go to the host they were
 * given for, never to the host it redirected to (a browser drops
 * `Authorization` on a cross-origin redirect it follows itself).
 *
 * Requests are counted in the realm's book of hosts (`hosts`, `hosts.js`:
 * each host's request budget, and whether it is delivering), and a wait it
 * names (a request budget's, a `Retry-After`) is waited for exactly and
 * heard by the read (`onWait`) and its link (`ResponseClock.onWait`), never
 * counted as a failure (`withRetries`).
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
 *   isStale?: (status: number) => boolean, isChanged?: (status: number) => boolean, generation?: unknown,
 *   unreadable?: string|null, limited?: string|null,
 *   confirmUnreadable?: () => Promise<boolean>}|null, hosts?: ReturnType<import('./hosts.js').createHostBook>}} [options]
 * @returns {ByteSource}
 */
export function httpByteSource({ url, size, name, identity = null, etag: knownTag = null, lastModified: knownModified = null, mirrors = [], head = null }, { fetch: fetchImpl = routedFetch, policy, access = null, hosts = realmHosts } = {}) {
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
  // What a rate-limit answer means at the provider (Google Drive's key, shared by every visitor).
  const limitedText = typeof access?.limited === 'string' ? access.limited : null;
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
   * `lane` names one and the request is preflighted). `call`: the read's
   * `{signal, clock, onBytes, onWait}`.
   */
  function request(target, headers, offset, length, call, lane = null) {
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
      signal: call.signal,
      clock: call.clock,
      wantsBody: response => response.status === 206 || (response.status === 200 && offset === 0 && length === size),
      expectedBytes: length,
      onBytes: call.onBytes,
      // A target URL may be pre-authenticated: failures name the display link.
      label: access === null ? target : originalUrl,
      hosts,
      onWait: call.onWait,
      // One of a file's many range reads (`hosts.js` `admit`).
      burst: true,
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

  /**
   * The answer of one request from `base` (or the final URL it redirected
   * to). A redirect to another host is asked with `Range` alone: a sign-in's
   * headers go to the host they were given for, never to wherever it
   * redirected (as a browser drops `Authorization` on a cross-origin
   * redirect it follows itself).
   */
  async function answerFrom(base, headers, offset, length, call, lane = null) {
    let redirect = redirects.get(base) ?? null;
    if (redirect !== null && redirect.expiresAt !== null && Date.now() >= redirect.expiresAt) {
      redirects.delete(base);
      redirect = null;
    }
    let answer = null;
    if (redirect !== null) {
      const sameHost = new URL(redirect.url).origin === new URL(base).origin;
      try {
        answer = await request(redirect.url, sameHost ? headers : {}, offset, length, call);
        if (answer.response.status !== 206) answer = null;
      } catch (error) {
        if (call.signal?.aborted) throw error;
        answer = null;
      }
      if (answer === null && redirects.get(base) === redirect) redirects.delete(base);
    }
    if (answer !== null) return { ...answer, base, redirectOf: base, sentAt: null };
    const sentAt = Date.now();
    answer = await request(base, headers, offset, length, call, lane);
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
  async function answerFromBases(offset, length, call) {
    const chosen = addresses.take();
    if (chosen !== 0) {
      let arrived = 0;
      const { onBytes } = call;
      try {
        const answer = await answerFrom(bases[chosen], {}, offset, length, {
          ...call,
          onBytes: onBytes === null ? null : bytes => {
            arrived += bytes;
            onBytes(bytes);
          },
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
        if (!isTransientAnswer(answer.response, answer.said)) addresses.wrong(chosen);
      } catch (error) {
        if (call.signal?.aborted) throw error;
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
      return answerFromBase(offset, length, call);
    }
    try {
      return await answerFrom(bases[0], {}, offset, length, call);
    } finally {
      addresses.release(0);
    }
  }

  /** The answer of one request from the file's own URL, counted as asked of it. */
  async function answerFromBase(offset, length, call) {
    const own = addresses.takeOwn();
    try {
      return await answerFrom(bases[own], {}, offset, length, call);
    } finally {
      addresses.release(own);
    }
  }

  /**
   * A new validator is a question its bytes answer (`read-witness.js`): GitHub
   * Pages gives every file of a site new ones at every deployment although
   * its bytes are the same. The range itself, when read before, and the
   * file's first, middle and last reads, asked for once per new validator, are
   * compared. Other bytes are refused, and every later read too: nothing
   * mixes two versions. With nothing read yet nothing proves it the same.
   */
  async function requireSameBytes(offset, bytes, tag, modified, call) {
    const refuse = () => {
      rewritten = modified === null
        ? `${fileName} changed on the host while it was open; open it again to read the new version.`
        : `${fileName} changed on the host while it was open (modified ${modified}); open it again to read the new version.`;
      return new ByteSourceError(BYTE_SOURCE_FAILURES.CHANGED, rewritten);
    };
    if (witness.compare('', offset, bytes) === 'different') throw refuse();
    const version = `${tag} ${modified}`;
    let asked = askedOfVersion.get(version);
    if (asked === undefined) {
      asked = (async () => {
        const witnesses = witness.witnessesAcross();
        if (witnesses.length === 0) return false;
        // Shared by every read waiting on it, so no one read's Stop ends it.
        const held = await Promise.all(witnesses.map(async each => witnessHolds(each, await readOnce(each.start, each.length, {
          signal: null, clock: call.clock, onBytes: null, onWait: call.onWait, witnessing: true,
        }))));
        return !held.includes(false);
      })();
      askedOfVersion.set(version, asked);
      // A failed asking (the link) says nothing of the file: asked again by the next read.
      asked.catch(() => askedOfVersion.delete(version));
    }
    if (!await asked) throw refuse();
  }

  async function readOnce(offset, length, call) {
    if (rewritten !== null) throw new ByteSourceError(BYTE_SOURCE_FAILURES.CHANGED, rewritten);
    const { signal } = call;
    let answer;
    if (access === null) {
      answer = await answerFromBases(offset, length, call);
    } else {
      let target = await awaitWithSignal(targetOf(null), signal);
      for (let renewed = false; ; renewed = true) {
        answer = await answerFrom(target.url, target.headers ?? {}, offset, length, call, target.lane);
        const answered = answer.response.status;
        if (answered !== 401 && access.isStale?.(answered) !== true) break;
        if (renewed) {
          throw new ByteSourceError(
            BYTE_SOURCE_FAILURES.HTTP,
            `${originalUrl}: the host refused the read (HTTP ${answered}) after its access was renewed.`,
            { status: answered }
          );
        }
        target = await awaitWithSignal(targetOf(target), signal);
      }
    }
    const { response, bytes, said } = answer;
    const status = response.status;
    // The version the target names is gone (a revision replaced since it was opened).
    if (access?.isChanged?.(status) === true) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.CHANGED,
        `${fileName} was replaced on its host since it was opened; open it again to read the new version.`,
        { status }
      );
    }
    if ((status === 200 || status === 206) && isWebPageAnswer(response, bytes)) {
      // A sign-in, preview or error page in place of the file: no read of
      // this link gets the file, whatever range it asks for.
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.UNREADABLE,
        webPageInsteadOf(fileName, hostOf(originalUrl)),
        { status, url: originalUrl, explained: true }
      );
    }
    if (status === 200 && !(offset === 0 && length === size)) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.RANGE_IGNORED,
        `${fileName}: the host ignores range requests, so the file cannot be read in place.`
      );
    }
    if (isTransientAnswer(response, said)) {
      const failure = transientStatusError(response, originalUrl, said);
      // What the provider says a rate limit means for this file (whose quota it is).
      if (failure.details.limiting && limitedText !== null) throw new ByteSourceError(failure.code, `${fileName}: ${limitedText}`, failure.details);
      throw failure;
    }
    if (status === 409) throw changedWhereServed(fileName, said, { url: originalUrl });
    if (status !== 206 && status !== 200) throw refusedStatusError(response, originalUrl, said);
    if (status === 206) requireAnsweredRange(response, offset, length, size, fileName);
    // Without an ETag, its modification time tells a new version.
    const responseTag = response.headers.get('ETag');
    const responseModified = responseTag === null ? response.headers.get('Last-Modified') : null;
    if (bytes.length !== length) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.SHORT_READ,
        `${fileName}: asked for ${formatCountOf(length, 'byte')} at ${offset}, received ${bytes.length}; the file may have changed.`
      );
    }
    if (call.witnessing !== true) {
      const moved = (responseTag !== null && etag !== null && responseTag !== etag)
        || (responseModified !== null && lastModified !== null && responseModified !== lastModified);
      if (moved) await requireSameBytes(offset, bytes, responseTag, responseModified, call);
      if (responseTag !== null) etag = responseTag;
      if (responseModified !== null) lastModified = responseModified;
      if (etag !== null || lastModified !== null) witness.note('', offset, bytes);
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

  /** What was read of the file, and what each new validator was found to be. */
  const witness = new ReadWitness();
  // The head read beside its probe, under the validators it was described with: read, wherever later reads are answered from.
  if (head instanceof Uint8Array && head.length > 0) witness.note('', 0, head);
  const askedOfVersion = new Map();
  /** Why every read is refused, once the file was found rewritten. */
  let rewritten = null;
  /** Requests made without a measured link (tests, a lone source) share one clock. */
  const ownClock = new ResponseClock();
  // Ranges of this file delivered so far: once any was, its host is waited for (`withRetries` `delivered`).
  let rangesDelivered = 0;
  const source = {
    size,
    name: fileName,
    url: originalUrl,
    identity: Object.freeze(identity ?? { kind: 'url', url: originalUrl, size }),
    // Six connections to each address a request may go to.
    policy: withPolicy(REMOTE_POLICY, { concurrency: REMOTE_POLICY.concurrency * bases.length, ...(policy ?? {}) }),
    /** What the host's request budget makes one more request cost now (`hosts.js`), for the reader's plans. */
    requestCostMs: () => hosts.requestCostMs?.(originalUrl) ?? 0,
    async read(offset, length, { signal = null, link = null, onBytes = null, onWait = null } = {}) {
      requireRange(source, offset, length);
      if (signal?.aborted) throw abortReason(signal);
      if (length === 0) return new Uint8Array(0);
      const clock = link?.responses ?? ownClock;
      // A wait the host names is heard by the read (its activity) and the link (its Transfers line).
      const heard = wait => {
        onWait?.(wait);
        clock.onWait?.(wait);
      };
      const attempts = (attemptSignal, onUnanswered) => withRetries(async () => {
        // Bytes of an attempt that fails are taken back: they did not arrive.
        let arrived = 0;
        try {
          const bytes = await readOnce(offset, length, {
            signal: attemptSignal,
            clock,
            onWait: heard,
            onBytes: onBytes === null ? null : bytes => {
              arrived += bytes;
              onBytes(bytes);
            },
          });
          rangesDelivered++;
          return bytes;
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
        onWait: heard,
        clock,
        random: spreadOf(`${originalUrl} ${offset}-${offset + length}`),
        // This file's ranges were delivered before: a refusal now is the
        // host refusing this network for now, waited out (`refusesForNow`).
        delivered: () => rangesDelivered > 0,
        hosts,
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
        if (signal?.aborted) throw abortReason(signal);
        throwIfAborted(confirmed.signal);
        // Repeats spent before the check answered: its answer names the failure.
        if (check !== null && isTransientFailure(error) && await awaitWithSignal(check, signal)) throw unreadableError(error);
        throw error;
      }
    },
  };
  return Object.freeze(source);
}

/** How a web page's text starts, after a byte order mark, white space and comments. */
const WEB_PAGE_START = /^(?:\s|<!--[\s\S]*?-->)*<(?:!doctype\s+html|html|head|body)[\s>]/i;
/** How much of a body is looked at to tell a web page. */
const WEB_PAGE_SNIFF_BYTES = 1024;

/**
 * Whether bytes are a web page (an HTML document) rather than data: a
 * sign-in or preview page a link answered with, a site's page a host sends
 * for any path it has nothing at (a single-page site answers every unknown
 * path with its own page), or a page
 * saved from a browser under a data file's name. No format Cellucid reads
 * starts as one does, so its first bytes decide.
 *
 * @param {Uint8Array|null} bytes - The first bytes (any number)
 * @returns {boolean}
 */
export function looksLikeWebPage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, WEB_PAGE_SNIFF_BYTES))
    .replace(/^﻿/, '');
  return WEB_PAGE_START.test(text);
}

/**
 * Whether a host answered a request with a web page instead of the object
 * asked for: the answer says it is HTML (`Content-Type`) and, where its body
 * is at hand, the body is one (`looksLikeWebPage`); an answer whose body was
 * not read (a range the host ignored) is judged by its type alone. A data
 * file or a Zarr object is never served as HTML.
 *
 * @param {Response} response
 * @param {Uint8Array|null} [bytes] - Its body, when read
 * @returns {boolean}
 */
export function isWebPageAnswer(response, bytes = null) {
  const type = response?.headers?.get?.('Content-Type') ?? '';
  if (!/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(type)) return false;
  return !(bytes instanceof Uint8Array) || bytes.length === 0 || looksLikeWebPage(bytes);
}

/**
 * What a person reads when a link answers with a web page instead of the
 * file it names (`isWebPageAnswer`): whose answer it was, and what to do.
 *
 * @param {string} name - The file asked for
 * @param {string|null} host - The host that answered
 * @returns {string}
 */
export function webPageInsteadOf(name, host) {
  return `${name}: ${host ?? 'its host'} answered with a web page instead of the file (a sign-in, preview or error page). ` +
    "Open the file's direct download link instead.";
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
 * A host that ignores ranges is never read whole: its body is canceled.
 * `once`: asked once, a failure reported as it is, for a caller that tells
 * the failures apart itself (Google Drive's hold of downloads without a
 * sign-in looks like a stall, then a failed connection).
 *
 * @param {string} url
 * @param {number} length
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch, once?: boolean,
 *   onWait?: ((wait: HostWait|null) => void)|null}} [options] - `onWait`: told
 *   of a wait the host names (`HostWait`), and null once it ends
 * @returns {Promise<{response: Response, bytes: Uint8Array|null, ms: number}>}
 */
export function readFileHead(url, length, { signal = null, fetchImpl = routedFetch, once = false, onWait = null } = {}) {
  return readHeadOf(url, length, signal, fetchImpl, new ResponseClock(), once, onWait);
}

async function readHeadOf(url, length, signal, fetchImpl, clock = new ResponseClock(), once = false, onWait = null) {
  const started = clock.now();
  // Past the HTTP cache, as every range read of a file (`httpByteSource`).
  const { response, bytes } = await withRetries(async () => {
    const answer = await fetchOnce(url, { headers: { Range: `bytes=0-${length - 1}` }, cache: 'no-store' }, {
      fetchImpl,
      signal,
      clock,
      wantsBody: reply => reply.status === 206,
      expectedBytes: length,
      onWait,
    });
    if (isTransientAnswer(answer.response, answer.said)) throw transientStatusError(answer.response, url, answer.said);
    return answer;
  }, { signal, clock, onWait, random: spreadOf(`${url} 0-${length}`), ...(once ? { retryable: () => false } : {}) });
  return { response, bytes, ms: clock.now() - started };
}

/**
 * What a host says about one file before it is read: its exact size, its
 * `ETag`/`Last-Modified`, the URL it answers from after redirects, and
 * whether it serves ranges. A host that names no size cannot be read in
 * place.
 *
 * One round trip: a `HEAD` asking for the range `bytes=0-` (a CORS-safelisted
 * header, so no preflight; past the HTTP cache, `no-store`, so its
 * validators are the host's now), whose `206` answer carries the stored size in
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
 * @param {{signal?: AbortSignal|null, fetchImpl?: typeof fetch, headBytes?: number, checkRange?: boolean,
 *   onWait?: ((wait: HostWait|null) => void)|null}} [options]
 *   `checkRange`: read one byte beside the `HEAD` even when no head is
 *   wanted, to prove a range can be read (a file read from its start as a
 *   stream, which a host may content-code: an R file is gzip); `onWait`:
 *   told of a wait the host names (its request budget, a `Retry-After`: a
 *   server preparing the file), and null once it ends
 * @returns {Promise<{url: string, size: number, etag: string|null, lastModified: string|null, rangeSupported: boolean|null,
 *   contentCoded: boolean, head: {bytes: Uint8Array, etag: string|null, ms: number}|null}>}
 */
export async function probeHttpResource(url, options = {}) {
  if (!Number.isSafeInteger(options.headBytes ?? 0) || (options.headBytes ?? 0) < 0) throw new TypeError('headBytes must be a whole number of bytes.');
  // The HEAD and the head read go out together: a file replaced between
  // their two answers would be named by one version and read from another.
  // It is probed again, once; two disagreements in a row are a file that
  // keeps changing.
  for (let probe = 0; ; probe++) {
    const { disagrees, ...probed } = await probeOnce(url, options);
    if (!disagrees) return probed;
    if (probe > 0) {
      throw new ByteSourceError(
        BYTE_SOURCE_FAILURES.CHANGED,
        `${url}: the host named two versions of the file in two answers in a row; it is being rewritten. Open it again once it is written.`,
        { url }
      );
    }
  }
}

/**
 * Whether a head read's answer names another version than the `HEAD` did
 * (`etag`, `lastModified`): each validator both state, compared without a
 * weak mark (a host may mark a whole answer weak and a range strong).
 */
function versionsDisagree(etag, lastModified, response) {
  if (response == null) return false;
  const strip = value => value.replace(/^W\//i, '');
  const tag = response.headers.get('ETag');
  const modified = response.headers.get('Last-Modified');
  return (etag !== null && tag !== null && strip(etag) !== strip(tag)) ||
    (lastModified !== null && modified !== null && lastModified !== modified);
}

async function probeOnce(url, { signal = null, fetchImpl = routedFetch, headBytes = 0, checkRange = false, onWait = null } = {}) {
  let size = null;
  let etag = null;
  let lastModified = null;
  let rangeSupported = null;
  let finalUrl = url;
  // The head goes out with the HEAD, not after it: both take one round trip.
  // One clock for the probe's requests: a silent host stalls them, never holds them.
  const clock = new ResponseClock();
  const headRead = headBytes > 0 || checkRange ? readHeadOf(url, Math.max(1, headBytes), signal, fetchImpl, clock, false, onWait) : null;
  headRead?.catch(() => {});
  try {
    // Past the HTTP cache, as the head and every read: the version a probe
    // names is the host's now, never one a cached answer kept.
    const { response: head } = await fetchOnce(url, { method: 'HEAD', headers: { Range: 'bytes=0-' }, cache: 'no-store' }, {
      fetchImpl,
      signal,
      clock,
      wantsBody: () => false,
      onWait,
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
    // A head whose body stopped coming (the host stalled, asked again until
    // the read's patience ran out) says nothing of how the host codes the
    // file: that host stalls, and is said to (read as content-coded, it
    // would be downloaded whole, which stalls again).
    if (failure?.code === BYTE_SOURCE_FAILURES.STALLED) throw failure;
    if (failure !== null || headOf.response.status !== 206 || headOf.bytes?.length !== asked) {
      if ((await wholeIsReadable(finalUrl, signal, fetchImpl)) !== null) {
        return { url: finalUrl, size, etag, lastModified, rangeSupported: false, contentCoded: true, head: null };
      }
      // Neither a range nor the whole: the probe stands without the head,
      // and opening's own reads say what fails.
      headOf = null;
    }
    return {
      url: finalUrl,
      size,
      etag,
      lastModified,
      rangeSupported,
      contentCoded: false,
      head: headOfFile(headOf, size, headBytes),
      disagrees: versionsDisagree(etag, lastModified, headOf?.response),
    };
  }
  let read;
  try {
    read = await (headRead ?? readHeadOf(url, 1, signal, fetchImpl, clock, false, onWait));
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
  const disagrees = versionsDisagree(etag, lastModified, response);
  etag ??= response.headers.get('ETag');
  lastModified ??= response.headers.get('Last-Modified');
  return {
    disagrees,
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
  const stop = onAbort(signal, () => controller.abort(abortReason(signal)));
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.body === null) return null;
    const { value } = await response.body.getReader().read();
    if (value === undefined || value.length === 0) return null;
    const length = Number(response.headers.get('Content-Length'));
    return { url: response.url || url, length: Number.isSafeInteger(length) && length > 0 ? length : null };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    return null;
  } finally {
    // Only its first bytes were wanted.
    cancel(controller, 'superseded', 'Only the first bytes were wanted.');
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
