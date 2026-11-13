/**
 * Data Source Interface and Base Utilities
 *
 * Provides a unified abstraction for data access that allows the app
 * to work with different data backends (the sample catalog, a file on this
 * computer, a link, a Cellucid server, a viewer opened by Python or R).
 */

import {
  getMetadataLoadSignal,
} from './metadata-load-contract.js';
import { compareCodePoints } from './data-mapping.js';
import { parseMappingEmbeddingPath } from './data-mapping-candidates.js';
import { StateValidator } from '../app/utils/state-validator.js';
import { getTransferLog } from './transfer-log.js';
import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  fetchOnce,
  HOST_FAULTS,
  hostFaultOfStatus,
  hostFaultSentence,
  isTransientAnswer,
  isWebPageAnswer,
  spreadOf,
  transientStatusError,
  unansweredFault,
  withRetries,
} from '../formats/io/byte-source.js';
import { ResponseClock } from '../formats/io/link.js';
import { realmHosts, retryAfterMilliseconds } from '../formats/io/hosts.js';
import { isObjectRecord, requireObjectKeys } from '../utils/exact-record.js';
import { formatCountOf } from '../utils/format-units.js';
import { publicLink } from './sources/link-credentials.js';
import { textWithPublicLinks } from './sources/link-text.js';
import { throwIfAborted } from '../utils/abort.js';

/**
 * @typedef {Object} DatasetStats
 * @property {number} n_cells - Number of cells/points
 * @property {number} n_genes - Number of genes
 * @property {number} n_obs_fields - Number of observation fields
 * @property {number} n_categorical_fields - Number of categorical fields
 * @property {number} n_continuous_fields - Number of continuous fields
 * @property {boolean} has_connectivity - Whether KNN data exists
 * @property {number|null} n_edges - Edge count; null without connectivity, or for a graph read straight from a file until its edges are read
 */

/**
 * @typedef {Object} DatasetObsField
 * @property {string} key - Field key/name
 * @property {'category'|'continuous'} kind - Field type
 * @property {number|null} [n_categories] - Number of categories (for
 *   categorical); null when they are found on first load (a direct AnnData
 *   string or boolean column)
 */

/**
 * @typedef {Object} DatasetSource
 * @property {string} name - Where the data comes from
 * @property {string} [url] - Its address
 * @property {string} [filename] - The file it was read from
 */

/**
 * @typedef {Object} DatasetCitation
 * @property {string} text - How to cite the dataset
 * @property {string} [url] - Its DOI or page
 */

/**
 * The identity of one open dataset: what the AnnData adapter states about the
 * file it reads (`BaseAnnDataAdapter.finalizeDirectIdentity`).
 *
 * @typedef {Object} DatasetMetadata
 * @property {string} id - The dataset id
 * @property {string} name - Human-readable display name
 * @property {string} description - Description (may be empty)
 * @property {DatasetStats} stats - Dataset statistics
 * @property {Object} embeddings - Exact available/default embedding metadata
 * @property {DatasetObsField[]} obs_fields - List of observation fields
 * @property {DatasetSource} [source] - Data source information
 * @property {DatasetCitation} [citation] - How to cite it
 * @property {string} [vector_field_default] - The vector field the dataset
 *   opens with (a launch's `vectorFieldDefault`)
 */

/**
 * What a dataset list shows about a dataset before it is opened: a catalog
 * describes its files from their metadata (`sources/anndata-catalog.js`); a
 * source that has opened its dataset lists the identity, which holds the
 * same members.
 *
 * @typedef {Object} DatasetSummary
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {{n_cells: number, n_genes: number}} stats
 */

// ============================================================================
// PAYLOAD SIZES
// ============================================================================
// A response read whole (a catalog, a session, a served dataset list) is not
// capped by a fixed number: the only limit is the memory the browser grants,
// and a refused allocation is reported as a TOO_LARGE load error naming the
// bytes. A caller that knows a document's exact bound passes it.

/**
 * The exact error a byte ceiling refuses with.
 *
 * A ceiling fires on well-formed data that is merely too big, so the refusal
 * has to be told apart from a malformed document. It carries a code for the
 * same reason every other loader failure does: the UI names a cause from the
 * code and never from the message text, so a refusal that published no code
 * would be given somebody else's advice — "re-export it", which regenerates a
 * byte-identical file, or "check your network", which worked.
 *
 * @param {string} message
 * @param {Object} [details]
 * @returns {DataSourceError}
 */
export function payloadTooLargeError(message, details = {}) {
  return new DataSourceError(
    message,
    DataSourceErrorCode.TOO_LARGE,
    null,
    details
  );
}

/**
 * Allocate a payload buffer, reporting a refused allocation as a TOO_LARGE
 * load error that names the bytes (the browser's memory, not a fixed cap,
 * is the limit).
 *
 * @param {number} byteLength
 * @param {string} label
 * @returns {Uint8Array}
 */
export function allocatePayloadBytes(byteLength, label) {
  try {
    return new Uint8Array(byteLength);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw payloadTooLargeError(
      `${label}: the browser could not allocate ${formatCountOf(byteLength, 'byte')} ` +
      'for this payload (not enough memory)',
      { label, declaredBytes: byteLength }
    );
  }
}

function requireByteCeiling(maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      `${label}: byte ceiling must be a non-negative safe integer, ` +
      `received ${String(maxBytes)}`
    );
  }
  return maxBytes;
}

/**
 * Read a response body into one Uint8Array, canceling the source stream the
 * moment it grows past `maxBytes` or the read fails for any other reason.
 *
 * This enforces a *ceiling*, which is deliberately not the same contract as
 * the exact-output-length reader owned by the session gzip codec
 * (`app/session/codecs/gzip.js`): a transfer's encoded size is not known
 * before it arrives, so it can only be capped. Exact-length enforcement of
 * decompressed payloads is delegated to that codec's `gzipDecompress()`.
 *
 * @param {Response} response
 * @param {Object} options
 * @param {string} options.label - Payload identity for error messages
 * @param {number} options.maxBytes - Hard ceiling on transferred bytes
 * @param {AbortSignal|null} [options.signal]
 * @param {((loadedBytes: number, totalBytes: number|null) => void)|null} [options.onProgress]
 * @param {number|null} [options.totalBytes] - Declared transfer size, used for
 *   progress and as the preallocation size for the body buffer
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedBody(response, options) {
  const {
    label,
    maxBytes,
    signal = null,
    onProgress = null,
    totalBytes = null,
  } = options;
  requireByteCeiling(maxBytes, label);

  const body = response.body;
  if (
    body === null ||
    body === undefined ||
    typeof body.getReader !== 'function'
  ) {
    throw new DataSourceError(
      `${label}: response carried no readable body`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { label }
    );
  }

  // A declared size within the ceiling is preallocated once, so the body is
  // copied straight into its final buffer. Without one (or when the body
  // outgrows it) chunks are kept and joined once at the end.
  const sizeHint = Number.isSafeInteger(totalBytes) && totalBytes > 0
    ? Math.min(totalBytes, maxBytes)
    : 0;
  let preallocated = sizeHint > 0 ? allocatePayloadBytes(sizeHint, label) : null;
  const chunks = [];
  let loadedBytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (chunk.byteLength === 0) continue;
      const nextLoadedBytes = loadedBytes + chunk.byteLength;
      if (nextLoadedBytes > maxBytes) {
        throw payloadTooLargeError(
          `${label}: transfer of at least ${formatCountOf(nextLoadedBytes, 'byte')} exceeds ` +
          `its ${maxBytes}-byte ceiling`,
          { label, loadedBytes: nextLoadedBytes, maxBytes }
        );
      }
      if (preallocated !== null && nextLoadedBytes > preallocated.byteLength) {
        chunks.push(preallocated.subarray(0, loadedBytes));
        preallocated = null;
      }
      if (preallocated !== null) {
        preallocated.set(chunk, loadedBytes);
      } else {
        chunks.push(chunk);
      }
      loadedBytes = nextLoadedBytes;
      if (onProgress !== null) onProgress(loadedBytes, totalBytes);
    }
    throwIfAborted(signal);
  } catch (error) {
    // Whatever ended the read (ceiling, abort, a throwing progress callback,
    // or a network error) stops the transfer instead of letting it run on.
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  if (preallocated !== null) {
    return loadedBytes === preallocated.byteLength
      ? preallocated
      : preallocated.slice(0, loadedBytes);
  }
  if (chunks.length === 1) return chunks[0];
  const merged = allocatePayloadBytes(loadedBytes, label);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Parse one JSON document, naming the only real limit on its size: the
 * engine's longest string (about 2^29 UTF-16 units in V8, 2^30 in Firefox).
 * A document longer than that cannot be parsed by any reader, so it is
 * reported as too large rather than as malformed.
 *
 * @param {Uint8Array} bytes
 * @param {string} label
 * @returns {any}
 */
export function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw payloadTooLargeError(
      `${label} (${formatCountOf(bytes.byteLength, 'byte')}) is longer than ` +
      'the longest text this browser can hold',
      { label, loadedBytes: bytes.byteLength }
    );
  }
  return JSON.parse(text);
}

/**
 * Read a response body as JSON. A metadata document has no fixed size limit;
 * a caller that knows a document's exact bound passes it as `maxBytes`.
 *
 * @param {Response} response
 * @param {Object} options
 * @param {string} options.label - Payload identity for error messages
 * @param {AbortSignal|null} [options.signal]
 * @param {number} [options.maxBytes]
 * @returns {Promise<any>}
 */
export async function readBoundedJson(response, options) {
  const {
    label,
    signal = null,
    maxBytes = Number.MAX_SAFE_INTEGER,
  } = options;
  const bytes = await readBoundedBody(response, {
    label,
    maxBytes,
    signal,
  });
  return parseJsonBytes(bytes, label);
}

// ============================================================================
// CATALOG FILES
// ============================================================================

/**
 * The one HTTP cache mode of every file a dataset catalog names
 * (`datasets.json`, a default session): revalidated with its host on every
 * request. A catalog republished at the same address lists files by path, and
 * a session is pinned by its digest; a copy reused without asking the host
 * (hosts such as GitHub Pages cache for minutes) would pair a new catalog with
 * an old session and refuse it. An unchanged file costs a conditional request
 * answered with 304.
 */
export const CATALOG_FILE_CACHE = 'no-cache';

/**
 * `fetch` that is never left hanging and rides out a host's transient
 * failures: a request is made again (`withRetries`, the byte reader's
 * repeats, their waits grown from the link's retransmission timeout) while
 * the host answers that it is busy or failing (HTTP 408, 429, 5xx, or a
 * rate limit it answers with 403), while its connection fails (GitHub Pages
 * answers a burst of requests with an occasional 503 that carries no CORS
 * headers, which a page sees only as a failed connection), and when it
 * stalls (no answer and no byte for the link's timeout, `ResponseClock`),
 * unless the failure shows it will stay (`worthAskingAgain`: the same error
 * status twice, or no answer twice), which is reported at once. It is sent
 * within its host's request budget (`formats/io/hosts.js`), and a wait the
 * host names (`Retry-After` where the host lets this page read it, a
 * budget's reset) is waited for exactly, never counted. The last answer is
 * returned as it is, busy or not, with its body already read; the caller
 * reports it. A connection still failing once the repeats are spent rejects
 * with an error naming the URL.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{clock?: import('../formats/io/link.js').ResponseClock}} [options] - `clock`: the
 *   link the waits grow from and run on (a fresh one of real time; tests give a virtual one)
 * @returns {Promise<Response>}
 */
export async function fetchWhenNotBusy(url, init = {}, { clock = new ResponseClock() } = {}) {
  const { signal = null, ...rest } = init;
  // The last busy answer: returned as it is once asking again is over.
  let busy = null;
  let answer;
  try {
    answer = await withRetries(async () => {
      const got = await sendOnce(url, rest, signal, clock);
      const status = got.response.status;
      const said = got.bytes !== null && status >= 400 ? new TextDecoder().decode(got.bytes) : got.said;
      if (isTransientAnswer(got.response, said)) {
        busy = got;
        throw transientStatusError(got.response, url, said);
      }
      return got;
    }, { signal, clock, random: spreadOf(url) });
  } catch (error) {
    const answered = error instanceof ByteSourceError &&
      (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || error.code === BYTE_SOURCE_FAILURES.UNAVAILABLE);
    if (!answered || busy === null || signal?.aborted) throw error;
    answer = busy;
  }
  return responseOf(answer);
}

/**
 * The one request of `fetchWhenNotBusy` and `fetchAnswer`, through the one
 * transport (`fetchOnce`), its body read (none for a `HEAD`).
 */
function sendOnce(url, init, signal, clock) {
  return fetchOnce(url, init, { fetchImpl: globalThis.fetch, signal, clock, wantsBody: () => init.method !== 'HEAD' });
}

/** A `fetchOnce` answer as a `Response`, its body the bytes read. */
function responseOf({ response, bytes }) {
  const bodiless = [101, 103, 204, 205, 304].includes(response.status);
  const answered = new Response(bodiless ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  // The final address after redirects, as `fetch` reports it.
  if (response.url) Object.defineProperty(answered, 'url', { value: response.url });
  return answered;
}

/**
 * `fetch` asked once, whatever it answers, through the one transport
 * (`fetchOnce`): sent within its host's request budget, never left hanging
 * (a host that stops answering fails it as stalled), and a request that got
 * no answer fails as one (`isUnanswered`, with its host, for the sentence
 * that says who is at fault), never as the browser's bare `TypeError`. For a
 * request never asked again: a person's "Try again" (`fetchCatalogFile`),
 * a Cellucid server's (`remote-source.js`: its failures are terminal).
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{clock?: import('../formats/io/link.js').ResponseClock}} [options]
 * @returns {Promise<Response>}
 */
export async function fetchAnswer(url, init = {}, { clock = new ResponseClock() } = {}) {
  const { signal = null, ...rest } = init;
  return responseOf(await sendOnce(url, rest, signal, clock));
}

/**
 * Fetch one file a dataset catalog names, revalidated with its host
 * ({@link CATALOG_FILE_CACHE}); a caller cannot choose another cache mode.
 * What it transfers is counted in the Transfers log under the link that owns
 * the URL, if any.
 *
 * A busy host is asked again ({@link fetchWhenNotBusy}) unless `askOnce` is
 * set. A person's "Try again" sets it: once a failure is on screen the person
 * decides when to ask again, so their retry is one request whose answer is
 * shown at once, not a schedule of requests running behind their notice
 * ({@link fetchAnswer}: still within the host's budget, never left hanging,
 * and a request without an answer said as one).
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{askOnce?: boolean}} [options]
 * @returns {Promise<Response>}
 */
export async function fetchCatalogFile(url, init, options = {}) {
  if (init !== undefined && init !== null && Object.hasOwn(init, 'cache')) {
    throw new TypeError(
      'Catalog files are always revalidated; a request cannot choose its cache mode.'
    );
  }
  const askOnce = requireAskOnce(options, 'Catalog file request');
  const request = { ...init, cache: CATALOG_FILE_CACHE };
  const response = await (askOnce ? fetchAnswer(url, request) : fetchWhenNotBusy(url, request));
  const length = Number(response.headers?.get?.('Content-Length'));
  getTransferLog().record(url, { bytes: Number.isSafeInteger(length) ? length : 0 });
  return response;
}

/**
 * Error codes for data source operations
 */
export const DataSourceErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  // A well-formed payload that is simply bigger than a browser ceiling. Kept
  // apart from INVALID_FORMAT because the two need opposite advice: one asks
  // for a re-export, the other says the export is fine and the browser is not.
  TOO_LARGE: 'TOO_LARGE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
  // An AnnData object none of whose obsm arrays can be plotted. The message
  // lists what obsm holds and why each entry was not used.
  NO_PLOTTABLE_EMBEDDING: 'NO_PLOTTABLE_EMBEDDING'
};

/**
 * User-friendly error messages
 */
export const ERROR_MESSAGES = {
  [DataSourceErrorCode.NOT_FOUND]: 'Dataset not found. Check that the directory exists.',
  [DataSourceErrorCode.FILE_NOT_FOUND]: 'Dataset file not found.',
  [DataSourceErrorCode.INVALID_FORMAT]: 'Invalid dataset format.',
  [DataSourceErrorCode.PERMISSION_DENIED]: 'Cannot access directory. Please grant permission.',
  [DataSourceErrorCode.NETWORK_ERROR]: 'Failed to load dataset. Check your connection.',
  [DataSourceErrorCode.TOO_LARGE]: 'Dataset is larger than Cellucid opens in a browser.',
  [DataSourceErrorCode.VALIDATION_ERROR]: 'Dataset validation failed.',
  [DataSourceErrorCode.UNSUPPORTED]: 'This operation is not supported.'
};

/** Error details with the links they name (`input`, `url`) in public form. */
function publicDetails(details) {
  if (details === null || typeof details !== 'object') return details;
  const named = {};
  for (const key of ['input', 'url']) {
    if (typeof details[key] === 'string') named[key] = publicLink(details[key]);
  }
  return Object.keys(named).length === 0 ? details : { ...details, ...named };
}

/**
 * Custom error class for data source operations.
 *
 * A failure names a link by its public form (`textWithPublicLinks`,
 * `sources/link-text.js`) in its message and in `details.input` and
 * `details.url`: what is shown and logged never holds a link's access key,
 * whichever site raised it.
 */
export class DataSourceError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code from DataSourceErrorCode
   * @param {string} [source] - Source type that generated the error
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code, source, details = {}) {
    super(textWithPublicLinks(message));
    this.name = 'DataSourceError';
    this.code = code;
    this.source = source;
    this.details = publicDetails(details);
  }

  /**
   * Get a user-friendly error message
   * @returns {string}
   */
  getUserMessage() {
    return ERROR_MESSAGES[this.code] || this.message;
  }
}

/**
 * A failure whose message is written for the person who asked for the data:
 * it says what is wrong with *their* data and what to do (a link that names
 * two files, a file with nothing to plot, an AnnData file too old to read).
 * It is shown as it is, never replaced by a generic cause. The mark is a
 * detail, so it survives the AnnData reader worker's error serialization.
 *
 * @param {string} message
 * @param {string} code - From DataSourceErrorCode
 * @param {string} [source]
 * @param {Object} [details]
 * @returns {DataSourceError}
 */
export function explainedFailure(message, code, source, details = {}) {
  return new DataSourceError(message, code, source, { ...details, explained: true });
}

/** The data source code each host fault (`HOST_FAULTS`) is classified by. */
const HOST_FAULT_CODES = Object.freeze({
  failing: DataSourceErrorCode.NETWORK_ERROR,
  limiting: DataSourceErrorCode.NETWORK_ERROR,
  refusing: DataSourceErrorCode.NETWORK_ERROR,
  silent: DataSourceErrorCode.NETWORK_ERROR,
  refused: DataSourceErrorCode.PERMISSION_DENIED,
  missing: DataSourceErrorCode.NOT_FOUND,
  offline: DataSourceErrorCode.NETWORK_ERROR,
  connection: DataSourceErrorCode.NETWORK_ERROR,
});

/** The host faults asking again may cure (the person is offered Try again first). */
export const PASSING_HOST_FAULTS = Object.freeze(new Set(['failing', 'limiting', 'refusing', 'silent', 'offline', 'connection']));

/**
 * A host that did not give what was asked for, said as who is at fault
 * (`hostFaultSentence`, `HOST_FAULTS`): the host failing or limiting on its
 * side, refusing this network for now, the link's permissions, nothing at
 * the address, or this computer offline. A failure written for the person
 * (`explainedFailure`); the faults that may pass (`PASSING_HOST_FAULTS`) are
 * never settled (`classifyDataSourceFailure`), so Try again comes first.
 * `details.hostFault` keeps what built it, so the link source names the
 * provider the host serves (`LinkDataSource`: "NCBI GEO
 * (ftp.ncbi.nlm.nih.gov)") and turns a refusal of a provider whose files
 * are all public into `refusing`.
 *
 * @param {{kind?: string, host: string, status?: number|null, what: string,
 *   service?: string|null, retryAfterMs?: number|null}} fault
 *   `kind`: from `HOST_FAULTS`, by default the status's (`hostFaultOfStatus`);
 *   `what`: what was asked for, a noun phrase ("GSE1_x.h5ad", "the file list
 *   of GSE1"); `service`: the provider the host serves, when known
 * @param {Object} [details] - `cause`: what it keeps under Details (the
 *   requests that met it, `hostFaultCause`), or null
 * @returns {DataSourceError}
 */
export function hostFaultFailure({ kind = null, host, status = null, what, service = null, retryAfterMs = null }, { cause = null, ...details } = {}) {
  const fault = { kind: kind ?? hostFaultOfStatus(status), host, status, what, service, retryAfterMs };
  if (!HOST_FAULTS.includes(fault.kind)) throw new TypeError(`No host fault for HTTP ${status}.`);
  return explainedFailure(hostFaultSentence(fault), HOST_FAULT_CODES[fault.kind], 'link', {
    ...details,
    ...(cause === null ? {} : { cause }),
    ...(status === null ? {} : { status }),
    host,
    hostFault: fault,
  });
}

/**
 * A provider's answer that is not OK, as its host fault, or null when its
 * status names none (`hostFaultOfStatus`: a 5xx, 408 or 429): the wait a
 * limiting host names (`Retry-After`) is said with it.
 *
 * @param {Response} response
 * @param {string} what
 * @param {Object} [details]
 * @returns {DataSourceError|null}
 */
export function hostFaultOfResponse(response, what, details = {}) {
  if (hostFaultOfStatus(response.status) === null) return null;
  const url = response.url || details.url || null;
  if (url === null || !URL.canParse(url)) return null;
  return hostFaultFailure({
    host: new URL(url).host,
    status: response.status,
    what,
    retryAfterMs: retryAfterMilliseconds(response.headers?.get?.('Retry-After') ?? null),
  }, details);
}

/**
 * What a host fault keeps under Details: the requests that met it (the
 * cause of one said so already, `withRetries`, `hostFaultFailure`), else
 * the failure itself; null for one said so that carries none. A failure
 * said again for the person (with the provider's name) takes it as its
 * cause, never the sentence it replaces.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
export function hostFaultCause(error) {
  if (error?.details?.hostFault === undefined) return error;
  return error.cause ?? error.details?.cause ?? null;
}

/**
 * The host fault (`hostFaultFailure`'s fields, without `what`) a failure
 * stands for, or null: one said so already (`hostFaultFailure`, or a read
 * the byte layer gave up on, `withRetries`, also as rebuilt from a reader
 * worker's answer, `utils/error-wire.js`), or any other failure that
 * carries a host-side status (`hostFaultOfStatus`) and the host or address
 * it came from (a catalog's `datasets.json`, `fetchJson`).
 *
 * @param {unknown} error
 * @returns {{kind: string, host: string, status: number|null, service: string|null, retryAfterMs: number|null}|null}
 */
export function hostFaultOf(error) {
  if (error instanceof AggregateError && error.errors.length > 0) return hostFaultOf(error.errors[0]);
  const details = error?.details;
  if (details === null || typeof details !== 'object') return null;
  if (details.hostFault !== undefined && details.hostFault !== null) {
    const { kind, host, status = null, service = null, retryAfterMs = null } = details.hostFault;
    return { kind, host, status, service, retryAfterMs };
  }
  const status = Number.isInteger(details.status) ? details.status : error?.status;
  const kind = hostFaultOfStatus(status);
  if (kind === null) return null;
  const host = typeof details.host === 'string' && details.host !== ''
    ? details.host
    : typeof details.url === 'string' && URL.canParse(details.url) ? new URL(details.url).host : null;
  return host === null ? null : { kind, host, status, service: null, retryAfterMs: null };
}

/**
 * What a failure that a host answered says to the person, by whose problem
 * it is, wherever it is shown (the sample catalog's notice, a served
 * source's or a notebook's connection, the startup panel, a notification):
 * a host fault said already (`hostFaultOf`), or any failure that carries the
 * host's status and the address it answered for (`details.status`,
 * `details.url`: a catalog's `datasets.json`, `cellucid serve`, a notebook
 * kernel's server): 5xx/408 failing, 429 limiting, 401/403 refused, 404/410
 * missing. Null when the failure names no host's answer (Cellucid's own
 * refusal of what it read, or a cause it cannot tell).
 *
 * @param {unknown} error
 * @returns {{kind: string, sentence: string}|null}
 */
export function describeHostFault(error) {
  if (error instanceof AggregateError && error.errors.length > 0) return describeHostFault(error.errors[0]);
  const said = error?.details?.hostFault;
  if (said !== undefined && said !== null) return { kind: said.kind, sentence: hostFaultSentence(said) };
  const details = error?.details;
  const status = Number.isInteger(details?.status) ? details.status : null;
  if (status === null || typeof details.url !== 'string' || !URL.canParse(details.url, globalThis.location?.href)) return null;
  const kind = hostFaultOfStatus(status) ??
    (status === 401 || status === 403 ? 'refused' : status === 404 || status === 410 ? 'missing' : null);
  if (kind === null) return null;
  const address = new URL(details.url, globalThis.location?.href);
  const what = decodeURIComponent(address.pathname.split('/').filter(Boolean).at(-1) ?? address.host);
  return { kind, sentence: hostFaultSentence({ kind, host: address.host, status, what }) };
}

/**
 * Whether a failure (or the first of an AggregateError) is explained.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isExplainedFailure(error) {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return isExplainedFailure(error.errors[0]);
  }
  return error?.details?.explained === true || isChangedOnHost(error);
}

/**
 * Whether a read failed because the file or store changed on its host while
 * it was open (`BYTE_SOURCE_FAILURES.CHANGED`, a sentence written for the
 * person). Reading again in this session gives the same answer: it keeps what
 * it was first answered with, so a host that redeploys the same bytes under
 * new validators counts as changed too (it cannot be told apart from new
 * bytes). Opening the data again reads what is there now.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChangedOnHost(error) {
  if (error instanceof AggregateError && error.errors.length > 0) return isChangedOnHost(error.errors[0]);
  return error?.code === BYTE_SOURCE_FAILURES.CHANGED;
}

/**
 * Resolve a relative URL against a base URL
 * @param {string} base - Base URL
 * @param {string} relative - Relative path
 * @returns {string} Resolved absolute URL
 */
export function resolveUrl(base, relative) {
  if (typeof base !== 'string' || base.length === 0) {
    throw new TypeError('URL base must be a non-empty string');
  }
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new TypeError('URL relative path must be a non-empty string');
  }

  const documentUrl = (
    typeof globalThis.window?.location?.href === 'string'
  )
    ? globalThis.window.location.href
    : undefined;
  const baseUrl = documentUrl === undefined
    ? new URL(base)
    : new URL(base, documentUrl);
  return new URL(relative, baseUrl).toString();
}

/**
 * Read `options.askOnce` of a catalog request: absent, or a boolean.
 *
 * @param {Object} options
 * @param {string} label
 * @returns {boolean}
 */
function requireAskOnce(options, label) {
  requireObjectKeys(options, [], ['askOnce'], `${label} options`);
  const askOnce = Object.hasOwn(options, 'askOnce') ? options.askOnce : false;
  if (typeof askOnce !== 'boolean') {
    throw new TypeError(`${label} options.askOnce must be a boolean`);
  }
  return askOnce;
}

/**
 * Fetch JSON data from a URL with error handling
 * @param {string} url - URL to fetch
 * @param {string} [sourceType] - Source type for error context
 * @param {{signal?: AbortSignal|null, askOnce?: boolean}} [options] - Exact
 *   request owner, and whether a busy host is asked only once
 *   ({@link fetchCatalogFile})
 * @returns {Promise<any>}
 */
export async function fetchJson(url, sourceType, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('JSON loader options must be an object');
  }
  const { askOnce = false, ...signalOptions } = options;
  if (typeof askOnce !== 'boolean') {
    throw new TypeError('JSON loader options.askOnce must be a boolean');
  }
  const signal = getMetadataLoadSignal(signalOptions, 'JSON loader');
  try {
    throwIfAborted(signal);
    // Revalidated like every catalog file (CATALOG_FILE_CACHE).
    const response = await fetchCatalogFile(
      url,
      signal === null ? undefined : { signal },
      { askOnce }
    );
    throwIfAborted(signal);
    if (!response.ok) {
      if (response.status === 404) {
        throw new DataSourceError(
          `Resource not found: ${url}`,
          DataSourceErrorCode.NOT_FOUND,
          sourceType,
          { url, status: response.status }
        );
      }
      throw new DataSourceError(
        `Failed to fetch: ${response.statusText}`,
        DataSourceErrorCode.NETWORK_ERROR,
        sourceType,
        { url, status: response.status }
      );
    }
    if (isWebPageAnswer(response)) {
      // A site's page for a path it has nothing at (a single-page site
      // answers every unknown path with it, 200): nothing is there, as a 404
      // says, not a network failure to try again.
      throw new DataSourceError(
        `Resource not found: ${url} (its host answered with a web page)`,
        DataSourceErrorCode.NOT_FOUND,
        sourceType,
        { url }
      );
    }
    const payload = await readBoundedJson(response, {
      label: `Metadata ${url}`,
      signal,
    });
    throwIfAborted(signal);
    return payload;
  } catch (err) {
    throwIfAborted(signal);
    if (err instanceof DataSourceError) throw err;
    // A request no answer came back for says whose problem it is where that
    // is known: this computer offline, its connection down, a host that
    // answered this site before (`unansweredFault`).
    const fault = err?.details?.hostFault ?? unansweredFault(err, realmHosts);
    if (fault != null) throw hostFaultFailure(fault, { url, cause: err });
    throw new DataSourceError(
      `Network error: ${err.message}`,
      DataSourceErrorCode.NETWORK_ERROR,
      sourceType,
      // The byte layer's own failure, so a caller can say who is at fault.
      { url, originalError: err.message, cause: err }
    );
  }
}

function invalidDatasetIdentity(message, sourceType, details = {}) {
  return new DataSourceError(
    `Invalid dataset identity: ${message}`,
    DataSourceErrorCode.INVALID_FORMAT,
    sourceType,
    details
  );
}

function requireIdentityKeys(value, required, optional, label, sourceType) {
  return requireObjectKeys(value, required, optional, label, (message, detail) =>
    invalidDatasetIdentity(message, sourceType, { label, ...detail }));
}

function requireNonEmptyString(value, label, sourceType) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidDatasetIdentity(
      `${label} must be a non-empty string`,
      sourceType,
      { label, value }
    );
  }
}

/**
 * Validate one exact dataset id shared by catalogs, identities, manager
 * selections, and browser URL publication.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function validateDatasetId(value, label = 'Dataset id') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${label} must be one non-empty, unpadded string without control characters.`
    );
  }
  return value;
}

function requireCount(value, label, sourceType) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidDatasetIdentity(
      `${label} must be a non-negative safe integer`,
      sourceType,
      { label, value }
    );
  }
}

function validateIdentityStats(stats, sourceType) {
  const countKeys = [
    'n_cells',
    'n_genes',
    'n_obs_fields',
    'n_categorical_fields',
    'n_continuous_fields',
  ];
  requireIdentityKeys(
    stats,
    [...countKeys, 'has_connectivity', 'n_edges'],
    [],
    'stats',
    sourceType
  );
  for (const key of countKeys) {
    requireCount(stats[key], `stats.${key}`, sourceType);
  }
  if (
    stats.n_obs_fields !==
    stats.n_categorical_fields + stats.n_continuous_fields
  ) {
    throw invalidDatasetIdentity(
      'stats.n_obs_fields must equal categorical plus continuous fields',
      sourceType,
      {
        n_obs_fields: stats.n_obs_fields,
        n_categorical_fields: stats.n_categorical_fields,
        n_continuous_fields: stats.n_continuous_fields,
      }
    );
  }
  if (typeof stats.has_connectivity !== 'boolean') {
    throw invalidDatasetIdentity(
      'stats.has_connectivity must be a boolean',
      sourceType,
      { value: stats.has_connectivity }
    );
  }
  if (stats.has_connectivity) {
    // Null: a graph read straight from a file, counted when its edges are
    // first read.
    if (stats.n_edges !== null) requireCount(stats.n_edges, 'stats.n_edges', sourceType);
  } else if (stats.n_edges !== null) {
    throw invalidDatasetIdentity(
      'stats.n_edges must be null when has_connectivity is false',
      sourceType,
      { value: stats.n_edges }
    );
  }
}

function requireDisplayIdentity(value, label, sourceType) {
  try {
    StateValidator.validateFieldKey(value);
  } catch (error) {
    throw invalidDatasetIdentity(
      `${label} ${JSON.stringify(value)} cannot be displayed exactly: ${error.message}`,
      sourceType,
      { label, value }
    );
  }
}

function validateEmbeddingSource(source, dimension, label, sourceType) {
  requireIdentityKeys(source, ['key', 'columns'], [], `${label}.source`, sourceType);
  requireNonEmptyString(source.key, `${label}.source.key`, sourceType);
  const columns = source.columns;
  if (
    !Array.isArray(columns) ||
    columns.length !== dimension ||
    columns.some(column => !Number.isSafeInteger(column) || column < 0) ||
    new Set(columns).size !== columns.length
  ) {
    throw invalidDatasetIdentity(
      `${label}.source.columns must be ${dimension} distinct 0-based column indices`,
      sourceType,
      { value: columns }
    );
  }
}

/**
 * The sole `embeddings` rule of a dataset identity.
 *
 * `embeddings` holds exactly `default_dimension`, `defaults`, and `items`:
 * - every item id obeys the field-identity rule; items are ordered by
 *   dimension ascending, then id in code-point order;
 * - an item holds exactly `label` (display text), `dimension` (1, 2 or 3),
 *   `path` (its `obsm/{i}/{cols}` route, `mappingEmbeddingPath`) and `source`
 *   (`key`: the `obsm` key; `columns`: `dimension` distinct 0-based indices,
 *   the columns its path reads);
 * - `defaults` has exactly one key per item dimension, ascending, each naming
 *   an item of that dimension;
 * - `default_dimension` is a key of `defaults`.
 *
 * @param {unknown} embeddings
 * @param {string} [sourceType]
 */
function validateIdentityEmbeddings(embeddings, sourceType) {
  requireIdentityKeys(
    embeddings,
    ['default_dimension', 'defaults', 'items'],
    [],
    'embeddings',
    sourceType
  );
  const items = embeddings.items;
  if (!isObjectRecord(items) || Object.keys(items).length === 0) {
    throw invalidDatasetIdentity(
      'embeddings.items must be a non-empty object',
      sourceType
    );
  }
  const dimensions = [];
  let previous = null;
  for (const [id, item] of Object.entries(items)) {
    const label = `embeddings.items.${id}`;
    requireDisplayIdentity(id, 'Embedding id', sourceType);
    requireIdentityKeys(item, ['label', 'dimension', 'path', 'source'], [], label, sourceType);
    requireDisplayIdentity(item.label, `${label}.label`, sourceType);
    if (!Number.isSafeInteger(item.dimension) || item.dimension < 1 || item.dimension > 3) {
      throw invalidDatasetIdentity(
        `${label}.dimension must be 1, 2, or 3`,
        sourceType,
        { value: item.dimension }
      );
    }
    if (
      previous !== null &&
      (
        previous.dimension > item.dimension ||
        (previous.dimension === item.dimension && compareCodePoints(previous.id, id) >= 0)
      )
    ) {
      throw invalidDatasetIdentity(
        'embeddings.items must be ordered by dimension, then id in code-point order',
        sourceType,
        { previous: previous.id, next: id }
      );
    }
    validateEmbeddingSource(item.source, item.dimension, label, sourceType);
    const route = parseMappingEmbeddingPath(item.path);
    if (
      route === null ||
      route.columns.length !== item.source.columns.length ||
      route.columns.some((column, position) => column !== item.source.columns[position])
    ) {
      throw invalidDatasetIdentity(
        `${label}.path must be the obsm route of its source columns`,
        sourceType,
        { value: item.path }
      );
    }
    if (dimensions[dimensions.length - 1] !== item.dimension) {
      dimensions.push(item.dimension);
    }
    previous = { id, dimension: item.dimension };
  }

  const defaults = embeddings.defaults;
  if (!isObjectRecord(defaults)) {
    throw invalidDatasetIdentity('embeddings.defaults must be an object', sourceType);
  }
  const expectedSlots = dimensions.map(dimension => `${dimension}d`);
  const actualSlots = Object.keys(defaults);
  if (actualSlots.join(',') !== expectedSlots.join(',')) {
    throw invalidDatasetIdentity(
      'embeddings.defaults must name exactly one item per embedding dimension, ascending',
      sourceType,
      { expected: expectedSlots, actual: actualSlots }
    );
  }
  for (const slot of expectedSlots) {
    const id = defaults[slot];
    if (
      typeof id !== 'string' ||
      !Object.hasOwn(items, id) ||
      `${items[id].dimension}d` !== slot
    ) {
      throw invalidDatasetIdentity(
        `embeddings.defaults.${slot} must name an item of that dimension`,
        sourceType,
        { value: id }
      );
    }
  }
  if (
    !Number.isSafeInteger(embeddings.default_dimension) ||
    !Object.hasOwn(defaults, `${embeddings.default_dimension}d`)
  ) {
    throw invalidDatasetIdentity(
      'embeddings.default_dimension must be a dimension named in embeddings.defaults',
      sourceType,
      { value: embeddings.default_dimension }
    );
  }
}

function validateIdentitySource(source, sourceType) {
  requireIdentityKeys(
    source,
    ['name'],
    ['url', 'filename'],
    'source',
    sourceType
  );
  requireNonEmptyString(source.name, 'source.name', sourceType);
  for (const key of ['url', 'filename']) {
    if (Object.hasOwn(source, key)) {
      requireNonEmptyString(
        source[key],
        `source.${key}`,
        sourceType
      );
    }
  }
}

function validateIdentityCitation(citation, sourceType) {
  requireIdentityKeys(citation, ['text'], ['url'], 'citation', sourceType);
  requireNonEmptyString(citation.text, 'citation.text', sourceType);
  if (Object.hasOwn(citation, 'url')) {
    requireNonEmptyString(citation.url, 'citation.url', sourceType);
  }
}

function validateIdentityObsFields(obsFields, stats, sourceType) {
  if (!Array.isArray(obsFields)) {
    throw invalidDatasetIdentity(
      'obs_fields must be an array',
      sourceType
    );
  }
  if (obsFields.length !== stats.n_obs_fields) {
    throw invalidDatasetIdentity(
      'obs_fields length must equal stats.n_obs_fields',
      sourceType,
      { actual: obsFields.length, expected: stats.n_obs_fields }
    );
  }

  const keys = new Set();
  let categoricalCount = 0;
  let continuousCount = 0;
  for (let index = 0; index < obsFields.length; index++) {
    const field = obsFields[index];
    const label = `obs_fields[${index}]`;
    if (!isObjectRecord(field)) {
      throw invalidDatasetIdentity(
        `${label} must be an object`,
        sourceType
      );
    }
    if (field.kind === 'category') {
      requireIdentityKeys(
        field,
        ['key', 'kind', 'n_categories'],
        [],
        label,
        sourceType
      );
      // Null: a string or boolean column, whose categories are found when
      // it is first loaded.
      if (field.n_categories !== null) {
        requireCount(
          field.n_categories,
          `${label}.n_categories`,
          sourceType
        );
      }
      categoricalCount++;
    } else if (field.kind === 'continuous') {
      requireIdentityKeys(
        field,
        ['key', 'kind'],
        [],
        label,
        sourceType
      );
      continuousCount++;
    } else {
      throw invalidDatasetIdentity(
        `${label}.kind must be 'category' or 'continuous'`,
        sourceType,
        { value: field.kind }
      );
    }
    requireNonEmptyString(field.key, `${label}.key`, sourceType);
    if (keys.has(field.key)) {
      throw invalidDatasetIdentity(
        `obs_fields contains duplicate key '${field.key}'`,
        sourceType,
        { key: field.key }
      );
    }
    keys.add(field.key);
  }
  if (
    categoricalCount !== stats.n_categorical_fields ||
    continuousCount !== stats.n_continuous_fields
  ) {
    throw invalidDatasetIdentity(
      'obs_fields kinds must agree with categorical and continuous stats',
      sourceType,
      {
        categoricalCount,
        continuousCount,
        expectedCategorical: stats.n_categorical_fields,
        expectedContinuous: stats.n_continuous_fields,
      }
    );
  }
}

/**
 * Validate one dataset identity, as the AnnData adapter builds it.
 *
 * @param {unknown} identity
 * @param {string} datasetId
 * @param {string} [sourceType]
 * @returns {Object}
 */
export function validateDatasetIdentity(
  identity,
  datasetId,
  sourceType
) {
  try {
    validateDatasetId(datasetId, 'Catalog dataset id');
  } catch (error) {
    throw invalidDatasetIdentity(
      error.message,
      sourceType,
      { datasetId }
    );
  }
  requireIdentityKeys(
    identity,
    [
      'id',
      'name',
      'description',
      'stats',
      'embeddings',
      'obs_fields',
    ],
    [
      'source',
      'citation',
      'vector_field_default',
    ],
    'dataset identity',
    sourceType
  );
  requireNonEmptyString(identity.name, 'name', sourceType);
  if (typeof identity.description !== 'string') {
    throw invalidDatasetIdentity(
      'description must be a string',
      sourceType,
      { value: identity.description }
    );
  }
  try {
    validateDatasetId(identity.id, 'Dataset identity id');
  } catch (error) {
    throw invalidDatasetIdentity(
      error.message,
      sourceType,
      { value: identity.id }
    );
  }
  if (identity.id !== datasetId) {
    throw invalidDatasetIdentity(
      `id '${identity.id}' does not match catalog id '${datasetId}'`,
      sourceType,
      { identityId: identity.id, datasetId }
    );
  }

  validateIdentityStats(identity.stats, sourceType);
  validateIdentityEmbeddings(identity.embeddings, sourceType);
  validateIdentityObsFields(
    identity.obs_fields,
    identity.stats,
    sourceType
  );

  if (Object.hasOwn(identity, 'source')) {
    validateIdentitySource(identity.source, sourceType);
  }
  if (Object.hasOwn(identity, 'citation')) {
    validateIdentityCitation(identity.citation, sourceType);
  }
  if (Object.hasOwn(identity, 'vector_field_default')) {
    requireDisplayIdentity(identity.vector_field_default, 'vector_field_default', sourceType);
  }
  return identity;
}

/**
 * Validate what a dataset list shows about one dataset (`DatasetSummary`): a
 * catalog's description of a file, or an open dataset's identity, which
 * holds the same members.
 *
 * @param {unknown} summary
 * @param {string} [sourceType]
 * @returns {DatasetSummary}
 */
export function validateDatasetSummary(summary, sourceType) {
  if (!isObjectRecord(summary)) {
    throw invalidDatasetIdentity('a listed dataset must be an object', sourceType);
  }
  try {
    validateDatasetId(summary.id, 'Listed dataset id');
  } catch (error) {
    throw invalidDatasetIdentity(error.message, sourceType, { value: summary.id });
  }
  requireNonEmptyString(summary.name, 'name', sourceType);
  if (typeof summary.description !== 'string') {
    throw invalidDatasetIdentity('description must be a string', sourceType, { value: summary.description });
  }
  if (!isObjectRecord(summary.stats)) {
    throw invalidDatasetIdentity('stats must be an object', sourceType);
  }
  requireCount(summary.stats.n_cells, 'stats.n_cells', sourceType);
  requireCount(summary.stats.n_genes, 'stats.n_genes', sourceType);
  return summary;
}

/**
 * The data source interface (duck typed: a source is any object with these
 * methods). Every dataset a source offers is read by the AnnData reader
 * through an `anndata-file-source.js` source, whatever format it arrived in.
 *
 * Required:
 * - `getType(): string` -- the source type ('local-demo', 'local-user',
 *   'link', 'remote', 'jupyter').
 * - `listDatasets(): Promise<DatasetSummary[]>` -- what the dataset list
 *   shows; an open dataset's identity is a summary too.
 * - `getMetadata(datasetId): Promise<DatasetMetadata>` -- the dataset's
 *   identity, opening its file first when a catalog lists it unopened.
 * - `getBaseUrl(datasetId): string` -- its `anndata://<id>/`
 *   base, under which the data loaders address its parts.
 *
 * Optional:
 * - `isAvailable(): Promise<boolean>`, `hasDataset(datasetId)`, `refresh()`,
 *   `requiresManualReconnect()`, `onDeactivate()`.
 * - `getAnnDataSource(datasetId)` -- the `AnnDataFileSource` a wrapper
 *   source reads `datasetId` from (`anndata-provider.js`).
 * - `getStateDescriptor(datasetId)` -- the default view a catalog names for a
 *   dataset (`app/session/catalog-default-session.js`), or null.
 * - `releaseExcept(datasetId)` -- release every open dataset but this one
 *   (null: all); called once a selection from the source is shown.
 */
