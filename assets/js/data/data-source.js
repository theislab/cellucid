/**
 * Data Source Interface and Base Utilities
 *
 * Provides a unified abstraction for data access that allows the app
 * to work with different data backends (local demo, user directory, remote server, Jupyter).
 */

import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
import { compareCodePoints } from './data-mapping.js';
import { StateValidator } from '../app/utils/state-validator.js';

/**
 * @typedef {Object} DatasetStats
 * @property {number} n_cells - Number of cells/points
 * @property {number} n_genes - Number of genes
 * @property {number} n_obs_fields - Number of observation fields
 * @property {number} n_categorical_fields - Number of categorical fields
 * @property {number} n_continuous_fields - Number of continuous fields
 * @property {boolean} has_connectivity - Whether KNN data exists
 * @property {number|null} n_edges - Edge count, or null without connectivity
 */

/**
 * @typedef {Object} DatasetObsField
 * @property {string} key - Field key/name
 * @property {'category'|'continuous'} kind - Field type
 * @property {number} [n_categories] - Number of categories (for categorical)
 */

/**
 * @typedef {Object} DatasetExportSettings
 * @property {number|null} compression - Gzip compression level
 * @property {number|null} var_quantization - Gene expression quantization bits
 * @property {number|null} obs_continuous_quantization - Continuous obs quantization bits
 * @property {string} obs_categorical_dtype - Categorical dtype ('uint8', 'uint16' or 'uint32')
 */

/**
 * @typedef {Object} DatasetSource
 * @property {string} [name] - Source name
 * @property {string} [url] - Source URL
 * @property {string} [citation] - Citation text
 */

/**
 * @typedef {Object} DatasetMetadata
 * @property {number} version - Exact dataset identity version
 * @property {string} id - Unique identifier (directory name)
 * @property {string} name - Human-readable display name
 * @property {string} description - Description (may be empty)
 * @property {string} [created_at] - ISO timestamp of export
 * @property {string} cellucid_data_version - Version of the cellucid package (Python or R) that wrote the export
 * @property {DatasetStats} stats - Dataset statistics
 * @property {Object} embeddings - Exact available/default embedding metadata
 * @property {DatasetObsField[]} obs_fields - List of observation fields
 * @property {DatasetExportSettings} [export_settings] - Export configuration
 * @property {DatasetSource} [source] - Data source information
 */

/**
 * Configuration constants for data loading
 */
const EXPORTS_QUERY_KEY = 'exportsBaseUrl';
const EXPORTS_META_SELECTOR =
  'meta[name="cellucid-exports-base-url"]';

function exportsConfigurationError(message) {
  const error = new Error(`Sample dataset configuration: ${message}`);
  error.name = 'ConfigurationError';
  return error;
}

function requireCanonicalPathSegments(
  pathname,
  owner,
  createError = message => new TypeError(message)
) {
  const segments = pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw createError(
        `${owner} contains invalid percent encoding`
      );
    }
    if (
      segment.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('%') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      encodeURIComponent(decoded) !== segment
    ) {
      throw createError(
        `${owner} contains a non-canonical path segment`
      );
    }
  }
}

function validateExportsBaseUrl(value, owner) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw exportsConfigurationError(
      `${owner} must contain one exact non-empty URL`
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw exportsConfigurationError(
      `${owner} must be an absolute HTTP(S) URL`
    );
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith('/') ||
    parsed.href !== value
  ) {
    throw exportsConfigurationError(
      `${owner} must be one canonical HTTP(S) directory URL with a trailing /`
    );
  }
  requireCanonicalPathSegments(
    parsed.pathname,
    owner,
    exportsConfigurationError
  );
  return parsed.href;
}

function readExportsConfiguration() {
  if (
    typeof window === 'undefined' ||
    typeof window.location?.href !== 'string'
  ) {
    return { baseUrl: null, error: null };
  }
  try {
    const pageUrl = new URL(window.location.href);
    const queryValues =
      pageUrl.searchParams.getAll(EXPORTS_QUERY_KEY);
    if (queryValues.length > 1) {
      throw exportsConfigurationError(
        `exactly one '${EXPORTS_QUERY_KEY}' query field is allowed`
      );
    }
    if (queryValues.length === 1) {
      return {
        baseUrl: validateExportsBaseUrl(
          queryValues[0],
          EXPORTS_QUERY_KEY
        ),
        error: null,
      };
    }

    if (typeof document === 'undefined') {
      return { baseUrl: null, error: null };
    }
    const metas = document.querySelectorAll(EXPORTS_META_SELECTOR);
    if (metas.length > 1) {
      throw exportsConfigurationError(
        'exactly one cellucid-exports-base-url meta element is allowed'
      );
    }
    if (metas.length === 0) {
      return { baseUrl: null, error: null };
    }
    const content = metas[0].getAttribute('content');
    return {
      baseUrl: validateExportsBaseUrl(
        content,
        'cellucid-exports-base-url meta content'
      ),
      error: null,
    };
  } catch (error) {
    return {
      baseUrl: null,
      error: error instanceof Error
        ? error
        : exportsConfigurationError(String(error)),
    };
  }
}

const exportsConfiguration = readExportsConfiguration();

export const DATA_CONFIG = {
  // Base paths
  EXPORTS_BASE_URL: exportsConfiguration.baseUrl,
  EXPORTS_CONFIGURATION_ERROR: exportsConfiguration.error,
  DATASETS_MANIFEST: 'datasets.json',

  // Required files for a valid dataset
  REQUIRED_FILES: [
    'dataset_identity.json',
    'obs_manifest.json'
  ],

  // Metadata file name
  DATASET_IDENTITY_FILE: 'dataset_identity.json',

  // Supported schema versions
  SUPPORTED_MANIFEST_VERSIONS: [1],
  SUPPORTED_IDENTITY_VERSIONS: [3]
};

// ============================================================================
// PAYLOAD SIZES
// ============================================================================
// Datasets are untrusted input: a user opens somebody else's GitHub repository
// the same way they open their own directory. A binary payload's size is not
// capped by a fixed number: every one is declared exactly by its manifest
// (cells x item size, edges x item size), checked against the transfer and the
// gzip envelope, and the only limit is the memory the browser grants. A
// refused allocation is reported as a TOO_LARGE load error naming the bytes.

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
 * Validate a manifest-declared payload length.
 *
 * @param {number} expectedBytes - Manifest-declared decoded length
 * @param {string} label - Payload identity for the error message
 * @returns {number} The validated length
 */
export function requireDeclaredPayloadLength(expectedBytes, label) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new RangeError(
      `${label}: declared payload length must be a non-negative safe integer, ` +
      `received ${String(expectedBytes)}`
    );
  }
  return expectedBytes;
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
      `${label}: the browser could not allocate ${byteLength.toLocaleString('en-US')} bytes ` +
      'for this payload (not enough memory)',
      { label, declaredBytes: byteLength }
    );
  }
}

/**
 * Largest gzip member that can legally encode `expectedBytes` of output.
 *
 * DEFLATE's worst case is a stored block per 65535 input bytes, each costing
 * five bytes, plus the ten-byte header, the eight-byte trailer, and room for
 * an optional file name. Anything larger cannot be a faithful encoding of the
 * declared payload, so the transfer is refused without inflating a byte.
 *
 * @param {number} expectedBytes
 * @returns {number}
 */
export function maxGzipTransferBytes(expectedBytes) {
  const storedBlocks = Math.ceil(expectedBytes / 65535) + 1;
  return expectedBytes + storedBlocks * 5 + 18 + 1024;
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
 * Read a response body into one Uint8Array, cancelling the source stream the
 * moment it grows past `maxBytes` or the read fails for any other reason.
 *
 * This enforces a *ceiling*, which is deliberately not the same contract as
 * the exact-output-length reader owned by the session gzip codec
 * (`app/session/codecs/gzip.js`): a transfer's encoded size is not knowable
 * from a manifest, so it can only be capped. Exact-length enforcement of
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
      throwIfMetadataAborted(signal, label);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (chunk.byteLength === 0) continue;
      const nextLoadedBytes = loadedBytes + chunk.byteLength;
      if (nextLoadedBytes > maxBytes) {
        throw payloadTooLargeError(
          `${label}: transfer of at least ${nextLoadedBytes} bytes exceeds ` +
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
    throwIfMetadataAborted(signal, label);
  } catch (error) {
    // Whatever ended the read (ceiling, abort, a throwing progress callback,
    // or a network error) stops the transfer instead of letting it run on.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
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
      `${label} (${bytes.byteLength.toLocaleString('en-US')} bytes) is longer than ` +
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
// SAMPLE EXPORT TRANSPORT
// ============================================================================

const REQUEST_METHODS = new Set(['GET', 'HEAD']);

/**
 * The one HTTP cache mode of every dataset artifact: catalogs, identities,
 * manifests and binary payloads alike.
 *
 * A dataset republished at the same URL keeps its payload paths. A path is an
 * index, not a name, so a re-export that adds one gene renumbers `var/`: the
 * file at `var/3.values.u8.gz` then holds another gene with exactly the same
 * byte length, and no length check can tell. A cached copy reused without
 * asking the origin (`force-cache`, or `default` within a host's max-age) would
 * draw the old gene's values under the new manifest's name. Revalidating
 * every request keeps the bytes and the manifests that describe them from one
 * publication; an unchanged file costs a conditional request answered with 304.
 */
export const DATASET_ARTIFACT_CACHE = 'no-cache';
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const SAMPLE_CORS_TRANSPORT = Object.freeze({
  credentials: 'omit',
  mode: 'cors',
  redirect: 'error',
});

function getAbsoluteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('Fetch URL must be a non-empty string.');
  }
  const documentUrl =
    typeof globalThis.window?.location?.href === 'string'
      ? globalThis.window.location.href
      : undefined;
  return documentUrl === undefined
    ? new URL(url).href
    : new URL(url, documentUrl).href;
}

function getAbsoluteExportsBaseUrl() {
  const base = DATA_CONFIG.EXPORTS_BASE_URL;
  if (base === null) return null;
  validateExportsBaseUrl(base, 'DATA_CONFIG.EXPORTS_BASE_URL');
  return getAbsoluteUrl(base);
}

function isExportsUrl(url) {
  const exportsBase = getAbsoluteExportsBaseUrl();
  if (!exportsBase) return false;
  const target = new URL(getAbsoluteUrl(url));
  const root = new URL(exportsBase);
  return (
    target.origin === root.origin &&
    target.search === '' &&
    target.hash === '' &&
    target.pathname.startsWith(root.pathname) &&
    target.pathname !== root.pathname
  );
}

function requireCanonicalExportsFileUrl(originalUrl, absoluteUrl) {
  if (originalUrl !== absoluteUrl) {
    throw new TypeError(
      'Sample request URL must be one canonical absolute URL.'
    );
  }
  const exportsBase = getAbsoluteExportsBaseUrl();
  if (exportsBase === null) {
    throw new Error('Sample exports root is not configured.');
  }
  const target = new URL(absoluteUrl);
  const root = new URL(exportsBase);
  if (
    target.origin !== root.origin ||
    target.search !== '' ||
    target.hash !== '' ||
    !target.pathname.startsWith(root.pathname) ||
    target.pathname === root.pathname
  ) {
    throw new TypeError(
      'Sample request URL must identify one file below the exact exports root.'
    );
  }
  const relativePath =
    target.pathname.slice(root.pathname.length);
  requireCanonicalPathSegments(
    `/${relativePath}`,
    'Sample request URL'
  );
  return absoluteUrl;
}

function validateExportsRequestOptions(init) {
  if (
    init !== undefined &&
    (
      init === null ||
      typeof init !== 'object' ||
      Array.isArray(init)
    )
  ) {
    throw new TypeError(
      'Sample request options must be an object when provided.'
    );
  }
  const value = init ?? {};
  const allowedKeys = new Set([
    'method',
    'cache',
    'headers',
    'signal',
    'priority',
  ]);
  const unsupported = Object.keys(value).filter(
    key => !allowedKeys.has(key)
  );
  if (unsupported.length > 0) {
    throw new TypeError(
      `Sample request contains unsupported option(s): ${unsupported.join(', ')}`
    );
  }
  const method = Object.hasOwn(value, 'method')
    ? value.method
    : 'GET';
  const signal = Object.hasOwn(value, 'signal')
    ? value.signal
    : null;
  if (!REQUEST_METHODS.has(method)) {
    throw new TypeError(
      'Sample request method must be exactly GET or HEAD.'
    );
  }
  if (
    signal !== null &&
    !(signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'Sample request signal must be an AbortSignal or null.'
    );
  }
  // The fetch priority hint (see data/fetch-scheduler.js).
  const priority = Object.hasOwn(value, 'priority') ? value.priority : 'auto';
  if (priority !== 'high' && priority !== 'low' && priority !== 'auto') {
    throw new TypeError(
      'Sample request priority must be exactly "high", "low" or "auto".'
    );
  }

  const headersValue = Object.hasOwn(value, 'headers')
    ? value.headers
    : {};
  if (
    headersValue === null ||
    typeof headersValue !== 'object' ||
    Array.isArray(headersValue) ||
    Object.getPrototypeOf(headersValue) !== Object.prototype
  ) {
    throw new TypeError(
      'Sample request headers must be a plain object.'
    );
  }
  const headers = Object.entries(headersValue)
    .sort(([left], [right]) => left.localeCompare(right));
  let previous = null;
  for (const [name, headerValue] of headers) {
    if (
      name !== name.toLowerCase() ||
      !HEADER_NAME.test(name) ||
      previous === name ||
      typeof headerValue !== 'string' ||
      /[\r\n\u0000]/.test(headerValue)
    ) {
      throw new TypeError(
        'Sample request headers require unique lowercase names and string values.'
      );
    }
    previous = name;
  }
  return Object.freeze({
    method,
    headers,
    signal,
    priority,
  });
}

/**
 * Fetch one data artifact. Files owned by the configured sample root use its
 * single current public transport: direct HTTP with browser CORS enforcement.
 * Other data sources retain the caller-provided HTTP transport options. Every
 * artifact is revalidated with its origin ({@link DATASET_ARTIFACT_CACHE});
 * a caller cannot choose another cache mode.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchSampleArtifact(url, init) {
  if (init !== undefined && init !== null && Object.hasOwn(init, 'cache')) {
    throw new TypeError(
      'Dataset artifacts are always revalidated; a request cannot choose its cache mode.'
    );
  }
  const absUrl = getAbsoluteUrl(url);

  if (!isExportsUrl(absUrl)) {
    return fetch(absUrl, { ...init, cache: DATASET_ARTIFACT_CACHE });
  }

  requireCanonicalExportsFileUrl(url, absUrl);
  const request = validateExportsRequestOptions(init);
  return fetch(absUrl, {
    ...SAMPLE_CORS_TRANSPORT,
    method: request.method,
    cache: DATASET_ARTIFACT_CACHE,
    headers: request.headers,
    signal: request.signal,
    priority: request.priority,
  });
}

/**
 * Validate that a manifest/identity version is supported
 * @param {number|undefined} version - Version from the JSON
 * @param {number[]} supportedVersions - Array of supported versions
 * @param {string} context - Context for error message (e.g., 'datasets.json')
 * @throws {DataSourceError} If version is not supported
 */
export function validateSchemaVersion(version, supportedVersions, context) {
  if (version === undefined) {
    throw new DataSourceError(
      `Missing required version field in ${context}`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { version, supportedVersions, context }
    );
  }

  if (!supportedVersions.includes(version)) {
    throw new DataSourceError(
      `Unsupported ${context} version: ${version}. Supported versions: ${supportedVersions.join(', ')}`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { version, supportedVersions, context }
    );
  }
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
  [DataSourceErrorCode.INVALID_FORMAT]: 'Invalid dataset format. Missing required files.',
  [DataSourceErrorCode.PERMISSION_DENIED]: 'Cannot access directory. Please grant permission.',
  [DataSourceErrorCode.NETWORK_ERROR]: 'Failed to load dataset. Check your connection.',
  [DataSourceErrorCode.TOO_LARGE]: 'Dataset is larger than Cellucid opens in a browser.',
  [DataSourceErrorCode.VALIDATION_ERROR]: 'Dataset validation failed.',
  [DataSourceErrorCode.UNSUPPORTED]: 'This operation is not supported.'
};

/**
 * Custom error class for data source operations
 */
export class DataSourceError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code from DataSourceErrorCode
   * @param {string} [source] - Source type that generated the error
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code, source, details = {}) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
    this.source = source;
    this.details = details;
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
 * Fetch JSON data from a URL with error handling
 * @param {string} url - URL to fetch
 * @param {string} [sourceType] - Source type for error context
 * @param {{signal?: AbortSignal|null}} [options] - Exact request owner
 * @returns {Promise<any>}
 */
export async function fetchJson(url, sourceType, options = {}) {
  const signal = getMetadataLoadSignal(options, 'JSON loader');
  try {
    throwIfMetadataAborted(signal, 'JSON loading');
    // Metadata is revalidated like every dataset artifact
    // (DATASET_ARTIFACT_CACHE): hosts such as GitHub Pages cache it for
    // minutes, and a stale catalog or manifest beside freshly deployed presets
    // and payloads makes a dataset fail to open until the cache expires.
    const response = await fetchSampleArtifact(
      url,
      signal === null ? undefined : { signal }
    );
    throwIfMetadataAborted(signal, 'JSON loading');
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
    const payload = await readBoundedJson(response, {
      label: `Metadata ${url}`,
      signal,
    });
    throwIfMetadataAborted(signal, 'JSON loading');
    return payload;
  } catch (err) {
    throwIfMetadataAborted(signal, 'JSON loading');
    if (err instanceof DataSourceError) throw err;
    throw new DataSourceError(
      `Network error: ${err.message}`,
      DataSourceErrorCode.NETWORK_ERROR,
      sourceType,
      { url, originalError: err.message }
    );
  }
}

function invalidDatasetIdentity(message, sourceType, details = {}) {
  return new DataSourceError(
    `Invalid dataset_identity.json: ${message}`,
    DataSourceErrorCode.INVALID_FORMAT,
    sourceType,
    details
  );
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label, sourceType) {
  if (!isPlainRecord(value)) {
    throw invalidDatasetIdentity(
      `${label} must be an object`,
      sourceType,
      { label, value }
    );
  }

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalidDatasetIdentity(
        `${label} is missing required field '${key}'`,
        sourceType,
        { label, key }
      );
    }
  }

  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidDatasetIdentity(
        `${label} contains unsupported field '${key}'`,
        sourceType,
        { label, key }
      );
    }
  }
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
  assertExactKeys(
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
    requireCount(stats.n_edges, 'stats.n_edges', sourceType);
  } else if (stats.n_edges !== null) {
    throw invalidDatasetIdentity(
      'stats.n_edges must be null when has_connectivity is false',
      sourceType,
      { value: stats.n_edges }
    );
  }
}

/**
 * The exact payload path of one embedding item: its position in item order and
 * its dimension, plus `.gz` exactly when the export was compressed. Both
 * writers derive the path this way and the reader accepts no other string.
 *
 * @param {number} index
 * @param {number} dimension
 * @param {number|null} compression
 * @returns {string}
 */
export function embeddingPayloadPath(index, dimension, compression) {
  return `embeddings/${index}_${dimension}d.bin${compression === null ? '' : '.gz'}`;
}

/**
 * The exact payload path of one vector field bound to one embedding item.
 *
 * @param {number} fieldIndex - Position of the field in `vector_fields.fields`.
 * @param {number} embeddingIndex - Position of the bound item in `embeddings.items`.
 * @param {number|null} compression
 * @returns {string}
 */
export function vectorPayloadPath(fieldIndex, embeddingIndex, compression) {
  return `vectors/${fieldIndex}_${embeddingIndex}.bin${compression === null ? '' : '.gz'}`;
}

/**
 * The gzip level an identity's payload paths are derived with: the export's
 * `export_settings.compression`, or null when the identity records no export
 * settings (a dataset served straight from AnnData was never compressed).
 *
 * @param {Object} identity
 * @returns {number|null}
 */
export function identityPayloadCompression(identity) {
  return Object.hasOwn(identity, 'export_settings')
    ? identity.export_settings.compression
    : null;
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
  assertExactKeys(source, ['key', 'columns'], [], `${label}.source`, sourceType);
  if (source.key !== null && (typeof source.key !== 'string' || source.key.length === 0)) {
    throw invalidDatasetIdentity(
      `${label}.source.key must be null or a non-empty string`,
      sourceType,
      { value: source.key }
    );
  }
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
 * The sole `embeddings` rule of dataset identity version 3.
 *
 * `embeddings` holds exactly `default_dimension`, `defaults`, and `items`:
 * - every item id obeys the field-identity rule; items are ordered by
 *   dimension ascending, then id in code-point order, and an item's position
 *   in that order is its payload index;
 * - an item holds exactly `label` (display text), `dimension` (1, 2 or 3),
 *   `file` (exactly `embeddings/{index}_{dimension}d.bin`, plus `.gz` when the
 *   export is compressed) and `source` (`key`: string or null; `columns`:
 *   `dimension` distinct 0-based indices);
 * - `defaults` has exactly one key per item dimension, ascending, each naming
 *   an item of that dimension;
 * - `default_dimension` is a key of `defaults`.
 *
 * @param {unknown} embeddings
 * @param {number|null} compression
 * @param {string} [sourceType]
 */
function validateIdentityEmbeddings(embeddings, compression, sourceType) {
  assertExactKeys(
    embeddings,
    ['default_dimension', 'defaults', 'items'],
    [],
    'embeddings',
    sourceType
  );
  const items = embeddings.items;
  if (!isPlainRecord(items) || Object.keys(items).length === 0) {
    throw invalidDatasetIdentity(
      'embeddings.items must be a non-empty object',
      sourceType
    );
  }
  const dimensions = [];
  let previous = null;
  let index = 0;
  for (const [id, item] of Object.entries(items)) {
    const label = `embeddings.items.${id}`;
    requireDisplayIdentity(id, 'Embedding id', sourceType);
    assertExactKeys(item, ['label', 'dimension', 'file', 'source'], [], label, sourceType);
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
    const expectedFile = embeddingPayloadPath(index, item.dimension, compression);
    if (item.file !== expectedFile) {
      throw invalidDatasetIdentity(
        `${label}.file must be exactly "${expectedFile}"`,
        sourceType,
        { value: item.file, expected: expectedFile }
      );
    }
    validateEmbeddingSource(item.source, item.dimension, label, sourceType);
    if (dimensions[dimensions.length - 1] !== item.dimension) {
      dimensions.push(item.dimension);
    }
    previous = { id, dimension: item.dimension };
    index += 1;
  }

  const defaults = embeddings.defaults;
  if (!isPlainRecord(defaults)) {
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

function validateIdentityExportSettings(settings, sourceType) {
  assertExactKeys(
    settings,
    [
      'compression',
      'var_quantization',
      'obs_continuous_quantization',
      'obs_categorical_dtype',
    ],
    [],
    'export_settings',
    sourceType
  );
  if (
    settings.compression !== null &&
    (
      !Number.isSafeInteger(settings.compression) ||
      settings.compression < 1 ||
      settings.compression > 9
    )
  ) {
    throw invalidDatasetIdentity(
      'export_settings.compression must be null or an integer from 1 to 9',
      sourceType
    );
  }
  for (const key of [
    'var_quantization',
    'obs_continuous_quantization',
  ]) {
    if (
      settings[key] !== null &&
      settings[key] !== 8 &&
      settings[key] !== 16
    ) {
      throw invalidDatasetIdentity(
        `export_settings.${key} must be null, 8, or 16`,
        sourceType
      );
    }
  }
  if (!['uint8', 'uint16', 'uint32'].includes(settings.obs_categorical_dtype)) {
    throw invalidDatasetIdentity(
      'export_settings.obs_categorical_dtype must be uint8, uint16 or uint32',
      sourceType
    );
  }
}

function validateIdentitySource(source, sourceType) {
  assertExactKeys(
    source,
    ['name'],
    ['url', 'citation', 'filename'],
    'source',
    sourceType
  );
  requireNonEmptyString(source.name, 'source.name', sourceType);
  for (const key of ['url', 'citation', 'filename']) {
    if (Object.hasOwn(source, key)) {
      requireNonEmptyString(
        source[key],
        `source.${key}`,
        sourceType
      );
    }
  }
}

/**
 * The sole `vector_fields` rule.
 *
 * `dataset_identity.json["vector_fields"]` is validated here and nowhere else,
 * so the hosted-catalog reader, the local prepared-export reader, and the
 * runtime VectorFieldManager cannot drift apart. Every rule below is stated by
 * the output format specification:
 *
 * - `vector_fields` holds exactly `default_field` and `fields`; `fields` is a
 *   non-empty object whose ids are in code-point order;
 * - a field entry holds exactly `label` and `files`, and `label` is the field
 *   id character for character;
 * - `files` maps each embedding id the field is bound to — a non-empty subset
 *   of `embeddings.items`, in item order — to exactly
 *   `vectors/{fieldIndex}_{embeddingIndex}.bin`, plus `.gz` when the export is
 *   compressed.
 *
 * @param {unknown} vectorFields
 * @param {{embeddingItems: Object, compression: number|null, sourceType?: string}} options
 *   `embeddingItems` is the identity's validated `embeddings.items`.
 * @returns {Object} the validated vector_fields object
 */
export function validateVectorFieldsMetadata(vectorFields, options) {
  if (
    !isPlainRecord(options) ||
    !isPlainRecord(options.embeddingItems) ||
    !(options.compression === null || Number.isSafeInteger(options.compression))
  ) {
    throw new TypeError(
      'validateVectorFieldsMetadata requires the identity embedding items and its compression.'
    );
  }
  const { embeddingItems, compression, sourceType = undefined } = options;
  assertExactKeys(
    vectorFields,
    ['default_field', 'fields'],
    [],
    'vector_fields',
    sourceType
  );
  if (
    !isPlainRecord(vectorFields.fields) ||
    Object.keys(vectorFields.fields).length === 0
  ) {
    throw invalidDatasetIdentity(
      'vector_fields.fields must be a non-empty object',
      sourceType
    );
  }
  if (vectorFields.default_field !== null) {
    requireNonEmptyString(
      vectorFields.default_field,
      'vector_fields.default_field',
      sourceType
    );
    if (!Object.hasOwn(
      vectorFields.fields,
      vectorFields.default_field
    )) {
      throw invalidDatasetIdentity(
        'vector_fields.default_field must be null or name a declared field',
        sourceType
      );
    }
  }
  const embeddingIndex = new Map(
    Object.keys(embeddingItems).map((id, index) => [id, index])
  );
  let previousFieldId = null;
  let fieldIndex = 0;
  for (const [fieldId, field] of Object.entries(vectorFields.fields)) {
    requireDisplayIdentity(fieldId, 'Vector field id', sourceType);
    if (previousFieldId !== null && compareCodePoints(previousFieldId, fieldId) >= 0) {
      throw invalidDatasetIdentity(
        'vector_fields.fields must be ordered by id in code-point order',
        sourceType,
        { previous: previousFieldId, next: fieldId }
      );
    }
    const label = `vector_fields.fields.${fieldId}`;
    assertExactKeys(field, ['label', 'files'], [], label, sourceType);
    if (field.label !== fieldId) {
      throw invalidDatasetIdentity(
        `${label}.label must be the field id "${fieldId}" exactly`,
        sourceType,
        { value: field.label }
      );
    }
    const files = field.files;
    if (!isPlainRecord(files) || Object.keys(files).length === 0) {
      throw invalidDatasetIdentity(
        `${label}.files must be a non-empty object`,
        sourceType
      );
    }
    let previousIndex = -1;
    for (const [embeddingId, path] of Object.entries(files)) {
      const index = embeddingIndex.get(embeddingId);
      if (index === undefined) {
        throw invalidDatasetIdentity(
          `${label}.files binds embedding "${embeddingId}", which embeddings.items does not declare`,
          sourceType,
          { embeddingId }
        );
      }
      if (index <= previousIndex) {
        throw invalidDatasetIdentity(
          `${label}.files must list its embeddings in embeddings.items order`,
          sourceType,
          { embeddingId }
        );
      }
      previousIndex = index;
      const expected = vectorPayloadPath(fieldIndex, index, compression);
      if (path !== expected) {
        throw invalidDatasetIdentity(
          `${label}.files.${embeddingId} must be exactly "${expected}"`,
          sourceType,
          { value: path, expected }
        );
      }
    }
    previousFieldId = fieldId;
    fieldIndex += 1;
  }
  return vectorFields;
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
    if (!isPlainRecord(field)) {
      throw invalidDatasetIdentity(
        `${label} must be an object`,
        sourceType
      );
    }
    if (field.kind === 'category') {
      assertExactKeys(
        field,
        ['key', 'kind', 'n_categories'],
        [],
        label,
        sourceType
      );
      requireCount(
        field.n_categories,
        `${label}.n_categories`,
        sourceType
      );
      categoricalCount++;
    } else if (field.kind === 'continuous') {
      assertExactKeys(
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
 * Validate the sole current dataset_identity.json version 3 contract.
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
  assertExactKeys(
    identity,
    [
      'version',
      'id',
      'name',
      'description',
      'cellucid_data_version',
      'stats',
      'embeddings',
      'obs_fields',
    ],
    [
      'created_at',
      'export_settings',
      'source',
      'vector_fields',
    ],
    'dataset identity',
    sourceType
  );
  validateSchemaVersion(
    identity.version,
    DATA_CONFIG.SUPPORTED_IDENTITY_VERSIONS,
    'dataset_identity.json'
  );
  requireNonEmptyString(identity.name, 'name', sourceType);
  if (typeof identity.description !== 'string') {
    throw invalidDatasetIdentity(
      'description must be a string',
      sourceType,
      { value: identity.description }
    );
  }
  requireNonEmptyString(
    identity.cellucid_data_version,
    'cellucid_data_version',
    sourceType
  );

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
  if (Object.hasOwn(identity, 'export_settings')) {
    validateIdentityExportSettings(
      identity.export_settings,
      sourceType
    );
  }
  const compression = identityPayloadCompression(identity);
  validateIdentityEmbeddings(identity.embeddings, compression, sourceType);
  validateIdentityObsFields(
    identity.obs_fields,
    identity.stats,
    sourceType
  );

  if (Object.hasOwn(identity, 'created_at')) {
    if (
      typeof identity.created_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
        identity.created_at
      ) ||
      !Number.isFinite(Date.parse(identity.created_at)) ||
      new Date(identity.created_at).toISOString().replace('.000Z', 'Z') !==
        identity.created_at
    ) {
      throw invalidDatasetIdentity(
        'created_at must be a valid UTC timestamp',
        sourceType,
        { value: identity.created_at }
      );
    }
  }
  if (Object.hasOwn(identity, 'source')) {
    validateIdentitySource(identity.source, sourceType);
  }
  if (Object.hasOwn(identity, 'vector_fields')) {
    validateVectorFieldsMetadata(identity.vector_fields, {
      embeddingItems: identity.embeddings.items,
      compression,
      sourceType,
    });
  }
  return identity;
}

/**
 * Load and validate exact metadata from dataset_identity.json.
 * @param {string} baseUrl - Base URL of the dataset
 * @param {string} datasetId - Dataset identifier
 * @param {string} [sourceType] - Source type for context
 * @param {{signal?: AbortSignal|null}} [options] - Exact request owner
 * @returns {Promise<DatasetMetadata>}
 */
export async function loadDatasetMetadata(
  baseUrl,
  datasetId,
  sourceType,
  options = {}
) {
  const signal = getMetadataLoadSignal(
    options,
    'Dataset metadata loader'
  );
  // Try to load dataset_identity.json first
  const identityUrl = resolveUrl(baseUrl, DATA_CONFIG.DATASET_IDENTITY_FILE);

  try {
    const identity = await fetchJson(
      identityUrl,
      sourceType,
      { signal }
    );
    throwIfMetadataAborted(signal, 'Dataset metadata loading');
    validateDatasetIdentity(identity, datasetId, sourceType);
    return { ...identity, id: datasetId };
  } catch (err) {
    throwIfMetadataAborted(signal, 'Dataset metadata loading');
    if (err instanceof DataSourceError && err.code === DataSourceErrorCode.NOT_FOUND) {
      throw new DataSourceError(
        'Missing required dataset_identity.json',
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { datasetId, baseUrl, identityUrl }
      );
    }
    throw err;
  }
}

/**
 * Check if a URL uses the local-user:// protocol
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isLocalUserUrl(url) {
  return url?.startsWith('local-user://');
}

/**
 * Data Source Interface Documentation
 *
 * This module uses duck typing - data sources don't need to extend a base class.
 * Any object implementing the following methods can be used as a data source:
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * REQUIRED METHODS (must implement)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * getType(): string
 *   Returns the source type identifier (e.g., 'local-demo', 'local-user', 'remote', 'jupyter')
 *
 * listDatasets(): Promise<DatasetMetadata[]>
 *   Lists all available datasets from this source
 *
 * getMetadata(datasetId): Promise<DatasetMetadata>
 *   Gets full metadata for a specific dataset
 *
 * getBaseUrl(datasetId): string
 *   Gets the base URL for loading dataset files. May return custom protocol URLs
 *   (e.g., 'local-user://datasetId/', 'remote://host/path/', 'jupyter://kernel/')
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * OPTIONAL METHODS (recommended)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * isAvailable(): Promise<boolean>
 *   Checks if the source is available/accessible (default: true)
 *
 * hasDataset(datasetId): Promise<boolean>
 *   Checks if a specific dataset exists
 *
 * refresh(): void
 *   Clears any cached data (manifests, metadata, etc.)
 *
 * requiresManualReconnect(): boolean
 *   Returns true if this source cannot be auto-restored from saved state
 *   (e.g., user directories require re-selection due to browser security,
 *    remote servers may need re-authentication)
 *
 * resolveUrl(url): Promise<string>
 *   Resolves a custom protocol URL (e.g., 'local-user://...') to a fetchable URL
 *   Called by DataSourceManager.resolveUrl() for protocol handling
 *
 * getFileUrl(filename): Promise<string>
 *   Gets a fetchable URL for a specific file within the current dataset
 *   Useful for sources that need to create Object URLs or signed URLs
 *
 * onDeactivate(): void
 *   Called when switching away from this source. Use for cleanup like:
 *   - Revoking Object URLs
 *   - Closing connections
 *   - Clearing temporary caches
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * REMOTE SERVER SOURCE INTERFACE (future: RemoteDataSource)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For sources that connect to remote servers (SSH tunnels, WebSocket APIs):
 *
 * connect(config): Promise<void>
 *   Establish connection to remote server
 *   @param config - Connection configuration (host, port, credentials, etc.)
 *
 * disconnect(): void
 *   Close connection cleanly
 *
 * isConnected(): boolean
 *   Check if currently connected
 *
 * getConnectionInfo(): {host: string, port: number, status: string}
 *   Get current connection details for debugging/display
 *
 * onConnectionLost(callback): void
 *   Register callback for connection loss events (for auto-reconnect UI)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * JUPYTER BRIDGE SOURCE INTERFACE (future: JupyterBridgeDataSource)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For sources that communicate with a Jupyter kernel via the cellucid Python package:
 *
 * connectToKernel(kernelId): Promise<void>
 *   Connect to a specific Jupyter kernel
 *
 * sendCommand(command, params): Promise<any>
 *   Send a command to the Python side (e.g., recompute, filter, export)
 *
 * onMessage(callback): void
 *   Register callback for messages from Python side (updates, progress, errors)
 *
 * getKernelStatus(): {kernelId: string, status: 'idle'|'busy'|'disconnected'}
 *   Get current kernel connection status
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * STREAMING/CHUNKED DATA INTERFACE (future extension)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For large datasets that need progressive loading:
 *
 * supportsStreaming(): boolean
 *   Returns true if this source supports chunked/streaming data
 *
 * loadChunk(datasetId, chunkSpec): Promise<ArrayBuffer>
 *   Load a specific chunk of data (e.g., range of points, subset of genes)
 *   @param chunkSpec - {type: 'points'|'obs'|'var', offset: number, limit: number}
 *
 * getChunkManifest(datasetId): Promise<ChunkManifest>
 *   Get information about available chunks for progressive loading
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROTOCOL REGISTRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Data sources using custom URL protocols should register them with DataSourceManager:
 *
 *   const manager = getDataSourceManager();
 *   manager.registerSource('remote', remoteSource);
 *   manager.registerProtocol('remote://', 'remote');
 *
 * This allows data-loaders.js to automatically resolve URLs like:
 *   'remote://server.example.com/dataset/embeddings/0_3d.bin'
 */

/**
 * Example base class showing the interface (not required to extend)
 * @abstract
 */
class BaseDataSource {
  constructor() {
    if (new.target === BaseDataSource) {
      throw new Error('BaseDataSource is abstract - use duck typing instead');
    }
  }

  /** @returns {string} */
  getType() {
    throw new Error('getType() must be implemented');
  }

  /** @returns {Promise<boolean>} */
  async isAvailable() {
    return true;
  }

  /** @returns {Promise<DatasetMetadata[]>} */
  async listDatasets() {
    throw new Error('listDatasets() must be implemented');
  }

  /** @param {string} _datasetId @returns {Promise<DatasetMetadata>} */
  async getMetadata(_datasetId) {
    throw new Error('getMetadata() must be implemented');
  }

  /** @param {string} _datasetId @returns {string} */
  getBaseUrl(_datasetId) {
    throw new Error('getBaseUrl() must be implemented');
  }

  /**
   * Whether this source requires manual reconnection (cannot be auto-restored from saved state).
   * Override this in sources like local-user or remote servers that need re-authentication.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return false;
  }
}
